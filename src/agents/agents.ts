import { hostname } from 'node:os'

import { isoNow } from '../events/format.ts'
import { isAgentOnline } from '../dashboard/model.ts'
import { replaceSectionRaw, setFields, setRegion, upsertSection } from '../obsidian/markdown.ts'
import { parseAgents, renderAgent, toAgentStatus } from '../obsidian/records.ts'
import { atomicWrite, readText, withLock } from '../filesystem/atomic.ts'
import type { Identity, Workspace } from '../obsidian/workspace.ts'
import type { Agent, AgentStatus } from '../types.ts'
import { assertAgentId, oneLineText } from '../coordination/validate.ts'

export interface RegisterOptions {
  /** Use exactly this id (Antigravity-01). */
  id?: string
  /** Allocate `<prefix>-NN` when no id is given. */
  prefix?: string
  session: string
  kind?: string
  branch?: string
  cwd?: string
  /** Tool capabilities to record (see src/agents/adapters.ts). */
  capabilities?: string[]
  /** `pid@host` of the long-lived process acting for this agent (the MCP server). */
  process?: string
  /**
   * With an explicit `id`: if that id belongs to another session whose
   * recorded process is still running on this machine, allocate the next
   * free id with the same prefix instead of sharing the identity.
   */
  exclusive?: boolean
}

export interface RegisterResult {
  agent: Agent
  /** True when an existing record for this session was resumed (restart recovery). */
  resumed: boolean
  /** The previous session of this id when it ended without `agent end` (crash, kill). */
  recoveredFrom?: string
  /** The preferred id that a live process already used (with `exclusive`). */
  displaced?: string
}

/** `Gemini-01` -> `Gemini`; an id without a numeric suffix is its own prefix. */
export function idPrefix(id: string): string {
  return id.replace(/-\d+$/, '') || id
}

/** `pid@host` -> whether that process still runs. Unknown or another host counts as alive. */
export function isProcessAlive(processRef: string | undefined): boolean {
  const match = /^(\d+)@(.+)$/.exec(processRef ?? '')
  if (!match) return false
  if (match[2] !== hostname()) return true
  try {
    process.kill(Number(match[1]), 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** This process as a `Process:` value. */
export function processRef(): string {
  return `${process.pid}@${hostname()}`
}

/**
 * Registers an agent. Allocation runs under the AGENTS.md lock, so two
 * sessions starting at once never receive the same id. A session that
 * registers again (hot reload, restart, resume) gets its previous id back; a
 * new session reuses the lowest-numbered id whose agent is offline.
 */
export function registerAgent(ws: Workspace, options: RegisterOptions): RegisterResult {
  let prefix = (options.prefix ?? ws.resolved.config.agentPrefix).replace(/[^\w.-]/g, '') || 'Agent'
  const now = isoNow()
  const nowMs = Date.now()
  const stale = ws.resolved.config.staleAgentMinutes
  let result: RegisterResult | undefined
  ws.mutate('agents', text => {
    const agents = parseAgents(text)
    let id = options.id?.trim() ? assertAgentId(options.id) : undefined
    let resumed = false
    let displaced: string | undefined
    if (id && options.exclusive) {
      const holder = agents.find(a => a.id.toLowerCase() === id!.toLowerCase())
      if (holder && holder.session !== options.session && isAgentOnline(holder, nowMs, stale) && isProcessAlive(holder.process)) {
        displaced = id
        prefix = idPrefix(id)
        id = undefined
      }
    }
    if (!id) {
      const mine = agents.find(a => a.session === options.session && options.session !== '')
      if (mine) {
        id = mine.id
        resumed = true
      }
    }
    if (!id) {
      for (let n = 1; n < 1000; n++) {
        const candidate = `${prefix}-${String(n).padStart(2, '0')}`
        const existing = agents.find(a => a.id.toLowerCase() === candidate.toLowerCase())
        if (!existing || !isAgentOnline(existing, nowMs, stale)) {
          id = candidate
          break
        }
      }
    }
    if (!id) throw new Error('No free agent id')
    const previous = agents.find(a => a.id.toLowerCase() === id!.toLowerCase())
    if (previous && previous.session === options.session) resumed = true
    // Same id, another session that never ended: the tool restarted after a
    // crash. Keep what it was working on; its tasks are still owned by this id.
    const recoveredFrom =
      !resumed && options.id && previous?.online && previous.session && !displaced ? previous.session : undefined
    const keep = resumed || recoveredFrom !== undefined
    const capabilities = options.capabilities ?? previous?.capabilities
    const processValue = options.process ?? (resumed ? previous?.process : undefined)
    const agent: Agent = {
      id,
      status: keep && previous ? previous.status : 'IDLE',
      task: keep && previous ? previous.task : '',
      branch: options.branch ?? ws.currentBranch(),
      session: options.session,
      kind: options.kind ?? previous?.kind ?? 'unknown',
      started: resumed && previous?.started ? previous.started : now,
      lastActivity: now,
      workingState: resumed && previous ? previous.workingState : recoveredFrom ? `Restarted after session ${recoveredFrom}` : 'Session started',
      online: true,
      ...(capabilities?.length ? { capabilities } : {}),
      ...(processValue ? { process: processValue } : {}),
    }
    result = { agent, resumed, ...(recoveredFrom ? { recoveredFrom } : {}), ...(displaced ? { displaced } : {}) }
    return upsertSection(text, id, renderAgent(agent))
  })
  const { agent, resumed } = result!
  const identity = { agent: agent.id, session: agent.session }
  writeSessionHeader(ws, agent, options.cwd ?? ws.resolved.projectRoot)
  if (resumed) {
    ws.emit(identity, 'SESSION_STARTED', `resumed session ${agent.session}`)
  } else if (result!.recoveredFrom) {
    ws.emit(identity, 'SESSION_STARTED', `restarted as ${agent.id} (session ${agent.session}; previous session ${result!.recoveredFrom} ended without notice)`)
  } else {
    ws.emit(identity, 'AGENT_REGISTERED', `registered (${agent.kind}) on ${agent.branch || 'no branch'}`, agent.id, {
      refreshNotes: false,
    })
    ws.emit(identity, 'SESSION_STARTED', `started session ${agent.session}`)
  }
  return result!
}

function writeSessionHeader(ws: Workspace, agent: Agent, cwd: string): void {
  const file = ws.sessionFile(agent.id)
  withLock(file, ws.lockOptions, () => {
    const current = readText(file) || `# Session journal · ${agent.id}\n\nWritten only by ${agent.id}.\n`
    const info = [
      `- Agent: ${agent.id}`,
      `- Kind: ${agent.kind}`,
      `- Session: ${agent.session}`,
      `- Started: ${agent.started}`,
      `- Branch: ${agent.branch || '-'}`,
      `- Directory: ${cwd}`,
    ].join('\n')
    const updated = setRegion(current, 'session', info)
    atomicWrite(file, updated.endsWith('\n\n') ? updated : `${updated.trimEnd()}\n\n`)
  })
}

export interface AgentUpdate {
  status?: AgentStatus | string
  task?: string
  workingState?: string
  branch?: string
  online?: boolean
}

/** Updates the agent's own section in place; returns the updated record. */
export function updateAgent(ws: Workspace, identity: Identity, update: AgentUpdate): Agent {
  assertAgentId(identity.agent)
  const now = isoNow()
  const text = ws.mutate('agents', current => {
    const fields = [
      { label: 'Status', value: update.status === undefined ? undefined : toAgentStatus(update.status) },
      { label: 'Task', value: update.task === undefined ? undefined : oneLineText(update.task, 200) || '-' },
      { label: 'Branch', value: update.branch },
      { label: 'Last Activity', value: now },
      { label: 'Working State', value: update.workingState === undefined ? undefined : oneLineText(update.workingState, 300) || '-' },
      { label: 'Online', value: update.online === undefined ? 'yes' : update.online ? 'yes' : 'no' },
    ]
    const replaced = replaceSectionRaw(current, identity.agent, raw => setFields(raw, fields))
    if (replaced !== undefined) return replaced
    // Not registered yet (an external agent using the CLI ad hoc): create it.
    const agent: Agent = {
      id: identity.agent,
      status: toAgentStatus(update.status ?? 'IDLE'),
      task: update.task ?? '',
      branch: update.branch ?? ws.currentBranch(),
      session: identity.session,
      kind: 'unknown',
      started: now,
      lastActivity: now,
      workingState: update.workingState ?? '',
      online: update.online ?? true,
    }
    return upsertSection(current, identity.agent, renderAgent(agent))
  })
  const agent = parseAgents(text).find(a => a.id.toLowerCase() === identity.agent.toLowerCase())
  if (!agent) throw new Error(`Agent ${identity.agent} not found after update`)
  return agent
}

export function setAgentStatus(
  ws: Workspace,
  identity: Identity,
  status: string,
  extra: Omit<AgentUpdate, 'status'> = {},
): Agent {
  const agent = updateAgent(ws, identity, { ...extra, status })
  const detail = [agent.task && `on ${agent.task}`, extra.workingState].filter(Boolean).join(' — ')
  ws.emit(identity, 'AGENT_STATUS', `is ${agent.status}${detail ? ` ${detail}` : ''}`, agent.id)
  return agent
}

/** Refreshes Last Activity without emitting an event. */
export function heartbeat(ws: Workspace, identity: Identity, workingState?: string): Agent {
  return updateAgent(ws, identity, workingState === undefined ? {} : { workingState })
}

export function endSession(ws: Workspace, identity: Identity, reason = 'ended'): Agent {
  const agent = updateAgent(ws, identity, { status: 'IDLE', online: false, workingState: `Session ${reason}` })
  ws.emit(identity, 'SESSION_ENDED', `ended session ${identity.session} (${reason})`, agent.id)
  return agent
}

/**
 * Marks agents offline in AGENTS.md whose `Last Activity` is older than
 * `staleAgentMinutes` while they still say `Online: yes` (a session that
 * crashed or was killed never runs `agent end`). Runs under the AGENTS.md
 * lock and re-checks each record there, so a heartbeat that lands first wins.
 * Never touches the caller's own record or one whose `Last Activity` cannot be
 * parsed. A live agent that was marked offline (e.g. after a suspend) flips
 * itself back with its next heartbeat. Returns the ids it marked offline.
 */
export function reapStaleAgents(ws: Workspace, identity: Identity, now = Date.now()): string[] {
  const stale = ws.resolved.config.staleAgentMinutes
  const reaped: string[] = []
  ws.mutate('agents', current => {
    let text = current
    for (const agent of parseAgents(current)) {
      if (!agent.online || agent.id.toLowerCase() === identity.agent.toLowerCase()) continue
      if (!agent.lastActivity || isAgentOnline(agent, now, stale)) continue
      const replaced = replaceSectionRaw(text, agent.id, raw =>
        setFields(raw, [
          { label: 'Online', value: 'no' },
          { label: 'Working State', value: `Marked offline: no activity for ${stale}+ min` },
        ]),
      )
      if (replaced === undefined) continue
      text = replaced
      reaped.push(agent.id)
    }
    return text
  })
  for (const id of reaped) ws.emit(identity, 'AGENT_STATUS', `marked ${id} offline (no activity for ${stale}+ min)`, id)
  return reaped
}

export function listAgents(ws: Workspace): Agent[] {
  return parseAgents(readText(ws.path('agents')))
}
