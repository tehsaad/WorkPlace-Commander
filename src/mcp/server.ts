/**
 * `wsc mcp`: a local MCP server (stdio, newline-delimited JSON-RPC 2.0) that
 * gives any MCP-capable AI tool the coordination tools: Gemini CLI,
 * Antigravity, Codex, Cursor, or another Claude Code.
 *
 * The server is the agent's session:
 * - on `initialize` it registers the agent (a stable id from `--agent`, its
 *   kind and capabilities from `--adapter`, `Process: pid@host` so a restart
 *   after a crash is recognized), and reaps agents that went stale;
 * - every tool call runs the same code path as the `wsc` CLI (locks, atomic
 *   writes, events), as that agent;
 * - while the tool runs it heartbeats, so the agent stays online;
 * - when the client closes stdin (the tool exits) it ends the session.
 *
 * Nothing but JSON-RPC is written to stdout; diagnostics go to stderr.
 * No dependencies: the protocol subset needed (initialize, ping, tools/list,
 * tools/call, roots/list) is small.
 */
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { AgentAdapter } from '../agents/adapters.ts'
import { endSession, heartbeat, processRef, reapStaleAgents, registerAgent } from '../agents/agents.ts'
import { buildContext, formatContext, lastInboxNumber } from '../coordination/context.ts'
import { COORDINATION_TOOLS } from '../coordination/tools.ts'
import { isCoordinationError, isUsageError, run } from '../commands/run.ts'
import { Workspace } from '../obsidian/workspace.ts'
import type { Identity } from '../obsidian/workspace.ts'

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
const SERVER_NAME = 'workspace-commander'

export interface McpServerOptions {
  /** Preferred agent id (`Gemini-01`); another live process holding it gets the next free one. */
  agent: string
  adapter: AgentAdapter
  version: string
  /** Repository to coordinate; else the client's first root; else the process's cwd. */
  cwd?: string
  config?: string
  session?: string
  input?: Readable
  output?: Writable
  log?: (line: string) => void
  heartbeatMs?: number
  /** Called once the session has ended (stdin closed or `close()`). */
  onExit?: () => void
}

type Json = Record<string, unknown>
type JsonRpcId = string | number

interface Pending {
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

export function startMcpServer(options: McpServerOptions): { close: (reason?: string) => void } {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const log = options.log ?? ((line: string) => process.stderr.write(`[workspace-commander] ${line}\n`))
  const session = options.session ?? `mcp_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  const pending = new Map<JsonRpcId, Pending>()
  let clientSupportsRoots = false
  let clientName = ''
  let cwd = options.cwd
  let identity: Identity | undefined
  let ready: Promise<Identity> | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let isClosed = false
  let requestCounter = 0

  const send = (message: Json) => {
    if (!isClosed) output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const reply = (id: JsonRpcId, result: unknown) => send({ id, result })
  const fail = (id: JsonRpcId, code: number, message: string) => send({ id, error: { code, message } })

  /** A request from the server to the client (roots/list); resolves undefined on timeout. */
  const ask = (method: string, params: Json = {}, timeoutMs = 3_000) =>
    new Promise<unknown>(resolve => {
      const id = `wc-${++requestCounter}`
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(undefined)
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      send({ id, method, params })
    })

  const workspaceArgs = () => [...(cwd ? ['--cwd', cwd] : []), ...(options.config ? ['--config', options.config] : [])]
  const openWorkspace = (agent = options.agent) => Workspace.open(cwd ?? process.cwd(), options.config, agent, { register: true })

  async function connect(): Promise<Identity> {
    if (!cwd && clientSupportsRoots) {
      const roots = (await ask('roots/list')) as { roots?: Array<{ uri?: string }> } | undefined
      const uri = roots?.roots?.find(r => typeof r.uri === 'string' && r.uri.startsWith('file://'))?.uri
      if (uri) cwd = fileURLToPath(uri)
    }
    const ws = openWorkspace()
    ws.init()
    const result = registerAgent(ws, {
      id: options.agent,
      kind: options.adapter.kind,
      capabilities: options.adapter.capabilities,
      session,
      process: processRef(),
      exclusive: true,
      cwd: cwd ?? process.cwd(),
    })
    const id: Identity = { agent: result.agent.id, session }
    reapStaleAgents(ws, id)
    if (result.displaced) log(`${result.displaced} is in use by another running session; acting as ${id.agent}`)
    if (result.recoveredFrom) log(`${id.agent} restarted; previous session ${result.recoveredFrom} had ended without notice`)
    log(`${id.agent} registered (${options.adapter.kind}${clientName ? `, client ${clientName}` : ''}) in ${ws.root}`)
    identity = id
    heartbeatTimer = setInterval(() => {
      try {
        const ws2 = openWorkspace(id.agent)
        heartbeat(ws2, id)
        reapStaleAgents(ws2, id)
      } catch (error) {
        log(`heartbeat failed: ${(error as Error).message}`)
      }
    }, options.heartbeatMs ?? 120_000)
    return id
  }

  const ensureReady = () => (ready ??= connect())

  /** Unread messages and waiting requests, appended to tool results (marked delivered). */
  function pendingNote(id: Identity): string {
    const ws = openWorkspace(id.agent)
    const context = buildContext(ws.snapshot(), id.agent, {
      now: Date.now(),
      staleMinutes: ws.resolved.config.staleAgentMinutes,
      readUpTo: ws.readCursor(id.agent),
    })
    if (!context.inbox.length) return ''
    ws.markRead(id.agent, lastInboxNumber(context))
    return `\n\nNew for ${id.agent}:\n${context.inbox.map(m => `- ${m.id} from ${m.from}: ${m.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`
  }

  async function callTool(name: string, args: Json): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const tool = COORDINATION_TOOLS[name]
    if (!tool || (tool.surfaces && !tool.surfaces.includes('mcp'))) {
      return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true }
    }
    const id = await ensureReady()
    try {
      const argv = [...tool.args(args), '--agent', id.agent, '--session', id.session, ...workspaceArgs()]
      const result = await run(argv)
      if (result === 'stream') throw new Error(`${name} cannot stream`)
      if (name !== 'workspace_status') {
        // Reads refresh Last Activity too; writes already did.
        heartbeat(openWorkspace(id.agent), id)
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) + pendingNote(id) }] }
      }
      return { content: [{ type: 'text', text: result.text }] }
    } catch (error) {
      const message = (error as Error).message
      const label = isCoordinationError(error) ? 'Refused' : isUsageError(error) ? 'Invalid input' : 'Error'
      return { content: [{ type: 'text', text: `${label}: ${message}` }], isError: true }
    }
  }

  async function handle(message: Json): Promise<void> {
    const id = message.id as JsonRpcId | undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    if (method === undefined) {
      // A response to one of our requests.
      const waiter = id === undefined ? undefined : pending.get(id)
      if (waiter) {
        clearTimeout(waiter.timer)
        pending.delete(id!)
        waiter.resolve(message.error ? undefined : message.result)
      }
      return
    }
    const params = (message.params ?? {}) as Json
    if (id === undefined) {
      // Notifications: start the session as soon as the client is ready.
      if (method === 'notifications/initialized') ensureReady().catch(error => log(`registration failed: ${(error as Error).message}`))
      return
    }
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '')
        clientSupportsRoots = Boolean((params.capabilities as Json | undefined)?.roots)
        clientName = String(((params.clientInfo as Json | undefined)?.name as string | undefined) ?? '')
        return reply(id, {
          protocolVersion: (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: options.version },
          instructions:
            `Shared multi-agent workspace (Workspace Commander). You are ${options.agent} (${options.adapter.name}). ` +
            'Call workspace_status first and after every restart: it lists your own open tasks (resume those), available tasks, unread messages and requests for you. ' +
            'Claim a task with task_claim before working on it and never take a task another online agent owns; report with task_update and task_complete; ' +
            'ask with request_create and wait with request_wait; answer requests with request_answer.',
        })
      }
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, {
          tools: Object.values(COORDINATION_TOOLS)
            .filter(t => !t.surfaces || t.surfaces.includes('mcp'))
            .map(t => ({ name: t.spec.name, description: t.spec.description, inputSchema: t.spec.inputSchema })),
        })
      case 'tools/call': {
        const name = String(params.name ?? '')
        const args = (params.arguments ?? {}) as Json
        try {
          return reply(id, await callTool(name, args))
        } catch (error) {
          return reply(id, { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true })
        }
      }
      case 'resources/list':
        return reply(id, { resources: [] })
      case 'prompts/list':
        return reply(id, { prompts: [] })
      default:
        return fail(id, -32601, `Method not found: ${method}`)
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (!line.trim()) return
    let message: Json
    try {
      message = JSON.parse(line) as Json
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return send({ id: null, error: { code: -32600, message: 'Invalid request' } })
    }
    handle(message).catch(error => log(`unhandled: ${(error as Error).message}`))
  })

  const close = (reason = 'MCP client closed the connection') => {
    if (isClosed) return
    isClosed = true
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    for (const waiter of pending.values()) clearTimeout(waiter.timer)
    lines.close()
    if (identity) {
      try {
        endSession(openWorkspace(identity.agent), identity, reason)
      } catch (error) {
        log(`could not end the session: ${(error as Error).message}`)
      }
    }
    options.onExit?.()
  }
  lines.on('close', () => {
    // Let a registration in flight finish, so the session it opens is ended.
    if (ready) ready.then(() => close(), () => close())
    else close()
  })
  return { close }
}
