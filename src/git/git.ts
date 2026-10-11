import { execFileSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

import { humanTime, isoNow } from '../events/format.ts'
import { readText } from '../filesystem/atomic.ts'
import { parseCommits, renderCommit } from '../obsidian/records.ts'
import type { Identity, Workspace } from '../obsidian/workspace.ts'
import type { CommitRecord, GitCommit } from '../types.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Pure: parses `git log --oneline` output. */
export function parseOneline(output: string): GitCommit[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const space = line.indexOf(' ')
      return space === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, space), subject: line.slice(space + 1) }
    })
}

/** `git log --oneline -n <count>`; [] outside a repository or before the first commit. */
export function gitLog(cwd: string, count = 5): GitCommit[] {
  try {
    return parseOneline(git(cwd, ['log', '--oneline', '-n', String(count)]))
  } catch {
    return []
  }
}

/** The repository's git directory (absolute), or undefined. */
export function gitDir(cwd: string): string | undefined {
  try {
    const dir = git(cwd, ['rev-parse', '--git-dir'])
    return isAbsolute(dir) ? dir : join(cwd, dir)
  } catch {
    return undefined
  }
}

function headHash(cwd: string): string | undefined {
  try {
    return git(cwd, ['rev-parse', 'HEAD'])
  } catch {
    return undefined
  }
}

/**
 * Records one commit in COMMITS.md and the event stream. Idempotent: a hash
 * already recorded is skipped, so every agent may call it safely.
 */
export function recordCommit(ws: Workspace, identity: Identity, rev = 'HEAD'): CommitRecord | undefined {
  const cwd = ws.resolved.projectRoot
  let hash: string
  let subject: string
  try {
    ;[hash = '', subject = ''] = git(cwd, ['log', '-1', '--format=%h%x00%s', rev]).split('\0')
  } catch {
    return undefined
  }
  if (!hash) return undefined
  let record: CommitRecord | undefined
  ws.appendRecord('commits', current => {
    if (parseCommits(current).some(c => c.hash.startsWith(hash) || hash.startsWith(c.hash))) return ''
    record = { hash, subject, agent: identity.agent, branch: ws.currentBranch(), timestamp: humanTime(isoNow()) }
    return renderCommit(record)
  })
  if (record) ws.emit(identity, 'COMMIT_CREATED', `committed ${record.hash} ${record.subject}`, record.hash)
  return record
}

/**
 * Records commits made since the last sync that no agent recorded (a human
 * committing in a terminal, an agent without Workspace Commander). The first
 * sync only sets the baseline, so history before the workspace is ignored.
 */
export function syncCommits(ws: Workspace, identity: Identity): CommitRecord[] {
  const cwd = ws.resolved.projectRoot
  const head = headHash(cwd)
  if (!head) return []
  const state = ws.readState()
  const key = `gitBaseline:${cwd}`
  const baseline = typeof state[key] === 'string' ? (state[key] as string) : undefined
  const recorded: CommitRecord[] = []
  if (baseline && baseline !== head) {
    let revs: string[] = []
    try {
      revs = git(cwd, ['rev-list', '--reverse', `${baseline}..${head}`]).split('\n').filter(Boolean)
    } catch {
      revs = [] // baseline no longer reachable (rebase): just move it
    }
    const known = parseCommits(readText(ws.path('commits')))
    for (const rev of revs.slice(-50)) {
      if (known.some(c => rev.startsWith(c.hash))) continue
      const record = recordCommit(ws, identity, rev)
      if (record) recorded.push(record)
    }
  }
  if (baseline !== head) ws.updateState(s => ({ ...s, [key]: head }))
  return recorded
}
