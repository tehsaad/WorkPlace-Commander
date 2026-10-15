/**
 * Agent adapters: how each AI tool joins a Workspace Commander workspace.
 * Pure data, shared by the CLI (`wsc adapters`, `wsc agent-setup`, `wsc mcp`)
 * and the documentation.
 *
 * Every tool ends up on the same protocol (the Markdown files, written under
 * the same locks); an adapter only describes the most capable route the tool
 * offers:
 *
 * - `native`: a plugin inside the tool registers, heartbeats, briefs and wakes
 *   the session by itself (Claude Code, through this repository's mod).
 * - `mcp`: the tool starts `wsc mcp`, a local stdio MCP server, and calls the
 *   coordination tools; the server registers the agent, heartbeats while the
 *   tool runs and ends the session when the tool closes it.
 * - `files`: the tool only reads and edits the Markdown, following
 *   AGENT_PROTOCOL.md (optionally running `wsc` from a shell).
 *
 * Adding a tool means adding one entry here; nothing else is tool-specific.
 */

/** Capability vocabulary recorded in AGENTS.md (`Capabilities:`). */
export const CAPABILITIES = {
  files: 'reads and edits the workspace Markdown',
  shell: 'can run the wsc CLI',
  mcp: 'calls the coordination tools over MCP',
  hooks: 'lifecycle hooks register and brief the session automatically',
  heartbeat: 'keeps Last Activity fresh while the session runs',
  wake: 'is woken when a message or answer arrives for it',
  git: 'commits are recorded in COMMITS.md',
} as const
export type Capability = keyof typeof CAPABILITIES

export type IntegrationLevel = 'native' | 'mcp' | 'files'

export interface InstructionTarget {
  /** Standing rule loaded into every chat (global). */
  global?: string
  /** Per-repository rule file, relative to the repository root. */
  project?: string
}

export interface McpSetup {
  /** Shell command that registers `wsc mcp` with the tool; `{launch}` becomes the full server command line. */
  command?: string
  /** Where the configuration lands, for people who edit it by hand. */
  config: string
  /** A config file snippet, when the tool is configured by editing JSON or TOML. */
  snippet?: 'json-mcpServers' | 'toml-codex'
}

export interface AgentAdapter {
  /** Stable key used on the command line: `wsc agent-setup gemini`. */
  key: string
  name: string
  /** Value written to `Kind:` in AGENTS.md. */
  kind: string
  /** Default id prefix: Gemini -> Gemini-01. */
  idPrefix: string
  level: IntegrationLevel
  capabilities: Capability[]
  /** Executables that indicate the tool is installed (first found wins). */
  executables: string[]
  /** Folders that indicate the tool was used on this machine (~ allowed). */
  configDirs: string[]
  instructions: InstructionTarget & { how: string }
  mcp?: McpSetup
  /** What was verified end to end with the real tool, and how. Empty = unverified. */
  verified: string
  /** Manual steps or known limits a user must know about. */
  notes: string[]
}

export const ADAPTERS: readonly AgentAdapter[] = [
  {
    key: 'claude-code',
    name: 'Claude Code',
    kind: 'claude-code',
    idPrefix: 'Claude',
    level: 'native',
    capabilities: ['files', 'shell', 'mcp', 'hooks', 'heartbeat', 'wake', 'git'],
    executables: ['claude'],
    configDirs: ['~/.claude'],
    instructions: { how: 'Nothing to configure: the Workspace Commander plugin briefs every session.' },
    verified:
      'claude plugin test (9 mod tests in the host) and a live headless session (Claude Code 2.1.300, 2026-10-15): registered, claimed, messaged, completed through the plugin tools (test/acceptance/live-agents.sh claude).',
    notes: ['Install the plugin once: ./install.sh (or claude plugin install workspace-commander@workspace-commander).'],
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    kind: 'gemini-cli',
    idPrefix: 'Gemini',
    level: 'mcp',
    capabilities: ['files', 'shell', 'mcp', 'heartbeat', 'git'],
    executables: ['gemini'],
    configDirs: ['~/.gemini'],
    instructions: {
      global: '~/.gemini/GEMINI.md',
      project: 'GEMINI.md',
      how: 'Gemini CLI loads ~/.gemini/GEMINI.md and <repo>/GEMINI.md into every chat.',
    },
    mcp: {
      config: '~/.gemini/settings.json → mcpServers (or <repo>/.gemini/settings.json)',
      snippet: 'json-mcpServers',
    },
    verified: '',
    notes: [
      'Not installed on the machine this was built on: the MCP route is tested with a protocol-level client, not with Gemini CLI itself.',
      '~/.gemini/GEMINI.md is also read by Antigravity; each tool gets its own marked block naming its own id.',
    ],
  },
  {
    key: 'antigravity',
    name: 'Google Antigravity',
    kind: 'antigravity',
    idPrefix: 'Antigravity',
    level: 'mcp',
    capabilities: ['files', 'shell', 'mcp', 'heartbeat', 'git'],
    executables: ['agy', 'antigravity'],
    configDirs: ['~/.gemini/antigravity'],
    instructions: {
      global: '~/.gemini/GEMINI.md',
      project: '.agent/rules/workspace-commander.md',
      how: 'Agent panel → … → Customizations → Rules → "+ Global" (stored in ~/.gemini/GEMINI.md), or a workspace rule in <repo>/.agent/rules/.',
    },
    mcp: {
      command: 'agy mcp add workspace-commander -- {launch}',
      config: 'agy mcp list (CLI). The IDE: Agent panel → … → MCP Servers → Manage → View raw config.',
    },
    verified: '',
    notes: [
      'The agy CLI and the IDE keep separate MCP settings; add the server in each one you use.',
      'If `workspace_status` shows the wrong project, the tool started the server outside the repository: add --cwd <repo> to the server arguments.',
    ],
  },
  {
    key: 'codex',
    name: 'OpenAI Codex CLI',
    kind: 'codex',
    idPrefix: 'Codex',
    level: 'mcp',
    capabilities: ['files', 'shell', 'mcp', 'heartbeat', 'git'],
    executables: ['codex', '/usr/lib/chatgpt/resources/codex'],
    configDirs: ['~/.codex'],
    instructions: {
      global: '~/.codex/AGENTS.md',
      project: 'AGENTS.md',
      how: 'Codex loads ~/.codex/AGENTS.md and AGENTS.md files from the repository root down.',
    },
    mcp: {
      command: 'codex mcp add workspace-commander -- {launch}',
      config: '~/.codex/config.toml → [mcp_servers.workspace-commander]',
      snippet: 'toml-codex',
    },
    verified:
      'Live with codex-cli 0.158.0-alpha.2 (2026-10-15): `codex exec` registered through wsc mcp, claimed, messaged and completed a task (test/acceptance/live-agents.sh codex).',
    notes: [
      'Codex asks before each MCP tool call; `codex exec` (no one to ask) refuses them unless the server sets default_tools_approval_mode = "approve".',
      'Codex does not pass your shell environment to MCP servers: set WSC_VAULT and friends in the server env table if you rely on them.',
      'Codex runs shell commands in a sandbox: writes to the vault from `wsc` need it allowed, so prefer the MCP route.',
    ],
  },
  {
    key: 'cursor',
    name: 'Cursor',
    kind: 'cursor',
    idPrefix: 'Cursor',
    level: 'mcp',
    capabilities: ['files', 'shell', 'mcp', 'heartbeat', 'git'],
    executables: ['cursor'],
    configDirs: ['~/.cursor'],
    instructions: {
      project: '.cursor/rules/workspace-commander.mdc',
      how: 'Settings → Rules → User Rules, or a project rule in <repo>/.cursor/rules/.',
    },
    mcp: { config: '~/.cursor/mcp.json or <repo>/.cursor/mcp.json → mcpServers', snippet: 'json-mcpServers' },
    verified: '',
    notes: ['Not installed on the machine this was built on: unverified with the real tool.'],
  },
  {
    key: 'generic',
    name: 'Any other agent',
    kind: 'agent',
    idPrefix: 'Agent',
    level: 'files',
    capabilities: ['files'],
    executables: [],
    configDirs: [],
    instructions: {
      project: 'AGENTS.md',
      how: "The tool's global or per-project instruction file (often AGENTS.md).",
    },
    mcp: { config: "The tool's MCP settings, if it has any (stdio server).", snippet: 'json-mcpServers' },
    verified: 'The Markdown protocol itself: test/integration.test.mjs edits the files by hand, the way such a tool does.',
    notes: ['Add shell to its capabilities if it can run `wsc`, and mcp if it can start an MCP server.'],
  },
]

/** Old names that `wsc agent-setup` accepted before adapters existed. */
const ALIASES: Record<string, string> = { 'gemini-cli': 'gemini', claude: 'claude-code', agent: 'generic', agy: 'antigravity' }

export function findAdapter(key: string | undefined): AgentAdapter | undefined {
  const k = (key ?? '').trim().toLowerCase()
  const wanted = ALIASES[k] ?? k
  return ADAPTERS.find(a => a.key === wanted || a.kind === wanted)
}

/** Default id for a tool: `Gemini-01`. */
export function defaultAgentId(adapter: AgentAdapter): string {
  return `${adapter.idPrefix}-01`
}
