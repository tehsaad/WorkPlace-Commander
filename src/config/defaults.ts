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

/**
 * A workspace file or folder name from configuration (`files.tasks`,
 * `projectNotes`, ...) must be a plain name inside the workspace folder: no
 * separators, no `..`, nothing hidden. Otherwise a repository's config file
 * could make every agent that works in it write outside the vault.
 */
export function assertWorkspaceFileName(key: string, name: string): string {
  const value = name.trim()
  if (!/^[^/\\\0]+$/.test(value) || value.startsWith('.') || value.length > 120) {
    throw new Error(`Invalid file name for ${key === 'projectNotes' ? key : `files.${key}`}: ${JSON.stringify(name)} (a plain name inside the workspace folder, e.g. TASKS.md)`)
  }
  return value
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
            ;(out.files as Record<string, string>)[fk] = assertWorkspaceFileName(fk, fv)
          }
        }
        continue
      }
      if (key === 'projectNotes' && typeof value === 'string') {
        out.projectNotes = assertWorkspaceFileName('projectNotes', value)
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
