import type { Config, WorkspaceFiles } from '../types.ts'

/** Pure: shared by the CLI and the hooks module. */
export const DEFAULT_CONFIG: Config = {
  obsidianVault: '~/Documents/Obsidian',
  workspaceDir: 'WorkspaceCommander',
  projectNotes: 'ProjectNotes.md',
  agentPrefix: 'Claude',
  staleAgentMinutes: 30,
  lockStaleMs: 10_000,
  gitLogCount: 5,
  autoWake: true,
  files: {
    agents: 'AGENTS.md',
    plan: 'PLAN.md',
    tasks: 'TASKS.md',
    messages: 'MESSAGES.md',
    requests: 'REQUESTS.md',
    milestones: 'MILESTONES.md',
    commits: 'COMMITS.md',
    sessionLog: 'SESSION_LOG.md',
    sessionsDir: 'SESSIONS',
    protocol: 'AGENT_PROTOCOL.md',
  },
}

/** Deep-merges partial configs over the defaults, ignoring unknown and mistyped keys. */
export function mergeConfig(...layers: ReadonlyArray<Record<string, unknown> | undefined>): Config {
  const out: Config = { ...DEFAULT_CONFIG, files: { ...DEFAULT_CONFIG.files } }
  for (const layer of layers) {
    if (!layer) continue
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'files' && value && typeof value === 'object') {
        for (const [fk, fv] of Object.entries(value)) {
          if (fk in out.files && typeof fv === 'string' && fv.trim() !== '') {
            ;(out.files as Record<string, string>)[fk] = fv
          }
        }
        continue
      }
      if (!(key in DEFAULT_CONFIG) && key !== 'project') continue
      const expected = key === 'project' ? 'string' : typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key]
      if (typeof value === expected) {
        ;(out as unknown as Record<string, unknown>)[key] = value
      }
    }
  }
  return out
}

export function workspaceFiles(config: Config): WorkspaceFiles {
  return { projectNotes: config.projectNotes, ...config.files }
}
