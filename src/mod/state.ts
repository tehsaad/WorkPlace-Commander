/**
 * Names shared by the hooks module. The `$.state` atoms themselves are
 * declared in hooks/register.tsx: the engine's scan reads them only there.
 */
export const PLUGIN = 'workspace-commander'
export const PANE_TITLE = 'Workspace Commander'

/** `$.store` keys. */
export const STORE = {
  gitVisible: 'gitVisible',
  sessionStart: (session: string) => `sessionStart:${session}`,
  /** Per workspace: $.store is shared by every project, and agent ids repeat across projects. */
  seen: (workspace: string, agent: string) => `seen:${workspace}:${agent}`,
} as const
