import { existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

export type WatchEvent =
  | { type: 'ready'; workspace: string; gitDir: string | null; recursive: boolean }
  | { type: 'workspace'; files: string[] }
  | { type: 'git'; files: string[] }
  | { type: 'error'; message: string }

const IGNORED = /(^|[\\/])(\.wc|\.obsidian|\.trash)([\\/]|$)|\.tmp$|~$|\.swp$/

/**
 * Only the workspace's own top-level notes count: other projects' folders may
 * sit inside this one (per-project folders under a shared root), and their
 * changes must not wake this project's sessions.
 */
function isWorkspaceNote(file: string): boolean {
  return file.endsWith('.md') && !IGNORED.test(file) && !/[\\/]/.test(file)
}

const GIT_FILES = new Set(['HEAD', 'ORIG_HEAD', 'packed-refs', 'FETCH_HEAD'])

/**
 * Watches the workspace folder and the repository's git metadata with the
 * platform's native file notifications (inotify, FSEvents, ReadDirectoryChangesW).
 * No polling and no child processes: changes are debounced into batches.
 */
export function watchWorkspace(
  workspace: string,
  gitDirectory: string | undefined,
  onEvent: (event: WatchEvent) => void,
  debounceMs = 150,
): () => void {
  const watchers: FSWatcher[] = []
  const pending = { workspace: new Set<string>(), git: new Set<string>() }
  let timer: NodeJS.Timeout | undefined

  const flush = () => {
    timer = undefined
    if (pending.workspace.size) onEvent({ type: 'workspace', files: [...pending.workspace].sort() })
    if (pending.git.size) onEvent({ type: 'git', files: [...pending.git].sort() })
    pending.workspace.clear()
    pending.git.clear()
  }
  const queue = (kind: 'workspace' | 'git', file: string) => {
    pending[kind].add(file)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }
  const add = (path: string, recursive: boolean, handler: (file: string) => void): boolean => {
    try {
      const w = watch(path, { recursive, persistent: true }, (_event, filename) => {
        if (filename) handler(filename.toString())
      })
      w.on('error', error => onEvent({ type: 'error', message: `${path}: ${error.message}` }))
      watchers.push(w)
      return true
    } catch (error) {
      if (recursive) return add(path, false, handler)
      onEvent({ type: 'error', message: `${path}: ${(error as Error).message}` })
      return false
    }
  }

  let recursive = true
  try {
    const w = watch(workspace, { recursive: true }, (_event, filename) => {
      const file = filename?.toString()
      if (file && isWorkspaceNote(file)) queue('workspace', file)
    })
    watchers.push(w)
  } catch {
    recursive = false
    add(workspace, false, file => {
      if (isWorkspaceNote(file)) queue('workspace', file)
    })
  }

  if (gitDirectory && existsSync(gitDirectory)) {
    // HEAD and packed-refs are replaced via rename, so watch their folders.
    add(gitDirectory, false, file => {
      if (GIT_FILES.has(file)) queue('git', file)
    })
    const heads = join(gitDirectory, 'refs', 'heads')
    if (existsSync(heads)) add(heads, true, file => queue('git', `refs/heads/${file}`))
    const logs = join(gitDirectory, 'logs')
    if (existsSync(logs)) add(logs, false, file => file === 'HEAD' && queue('git', 'logs/HEAD'))
  }

  onEvent({ type: 'ready', workspace, gitDir: gitDirectory ?? null, recursive })
  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}
