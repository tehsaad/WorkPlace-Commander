import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { ADAPTERS, CAPABILITIES, findAdapter } from '../agents/adapters.ts'
import type { AgentAdapter } from '../agents/adapters.ts'
import type { ResolvedConfig } from '../config/config.ts'
import { atomicWrite } from '../filesystem/atomic.ts'
import { setRegion } from '../obsidian/markdown.ts'
import { PACKAGE_ROOT } from '../obsidian/workspace.ts'
import { isoNow } from '../events/format.ts'

/**
 * One-time setup for AI tools that do not run the Claude Code mod
 * (Antigravity, Gemini CLI, Codex, Cursor, ...): a short standing rule the
 * tool loads into every chat, and the MCP server entry that gives it the
 * coordination tools. Which file and which command is the adapter's business
 * (src/agents/adapters.ts); this module only renders and writes.
 */

/** @deprecated kept for callers of 0.3: use ADAPTERS / findAdapter. */
export const AGENT_TARGETS: Record<string, { kind: string; where: string }> = Object.fromEntries(
  ADAPTERS.filter(a => a.key !== 'claude-code').map(a => [a.key, { kind: a.kind, where: a.instructions.how }]),
)

const expand = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

/** How to start the MCP server from any tool: absolute paths, no PATH lookup needed. */
export function mcpLaunch(id: string, adapter: AgentAdapter, cwd?: string): { command: string; args: string[] } {
  const args = [join(PACKAGE_ROOT, 'dist', 'cli.js'), 'mcp', '--agent', id, '--adapter', adapter.key]
  if (cwd) args.push('--cwd', cwd)
  return { command: process.execPath, args }
}

export function agentSetupSnippet(resolved: ResolvedConfig, tool: string, id: string): string {
  const adapter = findAdapter(tool)
  const name = adapter?.name ?? tool
  const kind = adapter?.kind ?? tool
  const base = join(resolved.vault, resolved.config.workspaceDir)
  const usesMcp = adapter?.level === 'mcp' || adapter?.level === 'native'
  return [
    `## Workspace Commander · ${name} (${id})`,
    '',
    `This block applies when you are ${name}. You work alongside other AI agents (Claude Code sessions and others) through a shared workspace of Markdown files in an Obsidian vault. Your agent ID is **${id}** (kind \`${kind}\`); use it in every session.`,
    '',
    ...(usesMcp
      ? [
          '1. If the `workspace-commander` MCP tools are available, use them: call `workspace_status` at the start of every task, after a restart, and before each significant step. It lists your own open tasks (resume those first), available tasks, unread messages, and requests waiting for you.',
          '2. Claim a task with `task_claim` before working on it; never take a task another online agent owns. Report progress with `task_update`, finish with `task_complete`, ask with `request_create` and wait with `request_wait`, answer with `request_answer`, message with `message_send`, and record shared decisions with `context_note`.',
          `3. Without the MCP tools: open \`${join(base, 'PROJECTS.md')}\`, find the workspace folder listed for your repository (else \`${resolved.workspace}\`), read its \`AGENT_PROTOCOL.md\` and follow it.`,
        ]
      : [
          `1. At the start of every task, open \`${join(base, 'PROJECTS.md')}\` and find the workspace folder listed for the repository you are working in. If the repository is not listed, use \`${resolved.workspace}\`.`,
          '2. In that folder, read `AGENT_PROTOCOL.md` and follow it. Register or refresh your section in `AGENTS.md`, then read `PLAN.md`, `TASKS.md`, `REQUESTS.md`, and the messages in `MESSAGES.md` addressed to you or `ALL`.',
          '3. Claim a task in `TASKS.md` before working on it, and never take a task another online agent owns. Answer requests addressed to you. Before each step, and while you wait on a request, re-read `MESSAGES.md`, `REQUESTS.md`, and `TASKS.md`.',
        ]),
    "4. Only append or edit single fields. Never delete or rewrite other agents' content or human notes.",
    `5. If you can run shell commands, the helper CLI locks files for you: \`wsc <command> --agent ${id}\` run in the repository (\`wsc context --agent ${id}\` is the same briefing as \`workspace_status\`).`,
    '',
  ].join('\n')
}

export interface McpInstructions {
  /** A shell command that registers the server, when the tool has one. */
  command?: string
  /** A config snippet to paste, when the tool is configured by file. */
  snippet?: string
  where: string
}

const shellQuote = (value: string) => (/^[\w./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

export function mcpInstructions(adapter: AgentAdapter, id: string, cwd?: string): McpInstructions | undefined {
  if (!adapter.mcp) return undefined
  const launch = mcpLaunch(id, adapter, cwd)
  const out: McpInstructions = { where: adapter.mcp.config }
  if (adapter.mcp.command) {
    out.command = adapter.mcp.command.replace('{launch}', [launch.command, ...launch.args].map(shellQuote).join(' '))
  }
  if (adapter.mcp.snippet === 'json-mcpServers') {
    out.snippet = JSON.stringify({ mcpServers: { 'workspace-commander': launch } }, null, 2)
  } else if (adapter.mcp.snippet === 'toml-codex') {
    out.snippet = [
      '[mcp_servers.workspace-commander]',
      `command = ${JSON.stringify(launch.command)}`,
      `args = [${launch.args.map(a => JSON.stringify(a)).join(', ')}]`,
      '# Without this, Codex asks before every call (and `codex exec` refuses them):',
      '# default_tools_approval_mode = "approve"',
    ].join('\n')
  }
  return out
}

/**
 * Writes the snippet into `file`, inside the `wc:agent-setup` block. The
 * block holds one `## Workspace Commander · <tool>` section per tool, so tools
 * that read the same file (Gemini CLI and Antigravity both load
 * ~/.gemini/GEMINI.md) each keep their own id. Only this tool's section is
 * replaced, anything outside the block is kept, and an existing file is copied
 * to `<file>.bak-<time>` first.
 */
export function writeAgentSetup(file: string, snippet: string): { file: string; backup?: string } {
  mkdirSync(dirname(file), { recursive: true })
  let backup: string | undefined
  let current = ''
  if (existsSync(file)) {
    current = readFileSync(file, 'utf8')
    backup = `${file}.bak-${isoNow().replace(/[:+]/g, '-')}`
    copyFileSync(file, backup)
  }
  const region = /<!-- wc:agent-setup:start -->\n([\s\S]*?)\n<!-- wc:agent-setup:end -->/.exec(current)?.[1] ?? ''
  const heading = (block: string) => /^## Workspace Commander · ([^(\n]+)/.exec(block)?.[1]?.trim() ?? ''
  const mine = heading(snippet)
  const blocks = region
    .split(/^(?=## Workspace Commander)/m)
    .map(b => b.trim())
    // A 0.3 block (no tool name in its heading) is replaced by the new one.
    .filter(b => b !== '' && heading(b) !== '' && heading(b) !== mine)
  atomicWrite(file, setRegion(current, 'agent-setup', [...blocks, snippet.trim()].join('\n\n')))
  return { file, ...(backup ? { backup } : {}) }
}

export interface AdapterStatus {
  key: string
  name: string
  kind: string
  level: string
  capabilities: string[]
  /** Path of the executable found, or ''. */
  installed: string
  /** Config folders that exist. */
  configFound: string[]
  /** Instruction files that already carry a Workspace Commander block for this tool. */
  ruleInstalled: string[]
  verified: string
  notes: string[]
  instructions: AgentAdapter['instructions']
  mcp?: AgentAdapter['mcp']
}

function which(executable: string): string {
  if (executable.includes('/')) return existsSync(executable) ? executable : ''
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, executable))) return join(dir, executable)
  }
  return ''
}

/** What `wsc adapters` reports: read-only detection, nothing is written. */
export function adapterStatus(adapter: AgentAdapter, projectRoot: string): AdapterStatus {
  const installed = adapter.executables.map(which).find(Boolean) ?? ''
  const files = [adapter.instructions.global, adapter.instructions.project && join(projectRoot, adapter.instructions.project)]
    .filter((f): f is string => Boolean(f))
    .map(expand)
  const ruleInstalled = files.filter(f => {
    try {
      const text = readFileSync(f, 'utf8')
      return text.includes('<!-- wc:agent-setup:start -->') && text.includes(`Workspace Commander · ${adapter.name}`)
    } catch {
      return false
    }
  })
  return {
    key: adapter.key,
    name: adapter.name,
    kind: adapter.kind,
    level: adapter.level,
    capabilities: adapter.capabilities,
    installed,
    configFound: adapter.configDirs.map(expand).filter(d => existsSync(d)),
    ruleInstalled,
    verified: adapter.verified,
    notes: adapter.notes,
    instructions: adapter.instructions,
    ...(adapter.mcp ? { mcp: adapter.mcp } : {}),
  }
}

export function describeCapabilities(capabilities: readonly string[]): string {
  return capabilities.map(c => `${c} (${CAPABILITIES[c as keyof typeof CAPABILITIES] ?? 'custom'})`).join(', ')
}
