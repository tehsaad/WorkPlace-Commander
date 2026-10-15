import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Concurrency primitives for Markdown files that several agents (and humans
 * in Obsidian) may touch at the same time.
 *
 * - Locks are `<workspace>/.wc/locks/<file>.lock`, created with O_EXCL so only
 *   one process can hold one. A lock older than `staleMs`, or one whose holder
 *   process on this machine has exited, is assumed abandoned (crashed agent)
 *   and taken over by exactly one waiter. The `.wc` folder is hidden from Obsidian.
 * - Rewrites go through a temp file in the same folder and `rename`, so a
 *   reader never sees a half-written file.
 * - Event streams are appended with O_APPEND under the same lock.
 */

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

export interface LockOptions {
  /** Where lock files live; normally `<workspace>/.wc/locks`. */
  lockDir: string
  staleMs: number
  timeoutMs?: number
  owner?: string
}

export class LockTimeoutError extends Error {
  constructor(file: string, holder: string) {
    super(`Timed out waiting for the lock on ${file} (held by ${holder || 'unknown'})`)
    this.name = 'LockTimeoutError'
  }
}

/** Runs `fn` while holding the exclusive lock for `file`. */
export function withLock<T>(file: string, options: LockOptions, fn: () => T): T {
  mkdirSync(options.lockDir, { recursive: true })
  const lockPath = join(options.lockDir, `${basename(file)}.lock`)
  const token = `${process.pid}@${hostname()}:${randomBytes(4).toString('hex')}`
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ token, owner: options.owner ?? '', at: new Date().toISOString() }))
      closeSync(fd)
    } catch (error) {
      fd = undefined
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder = ''
      try {
        // Age and holder from one open file: with a stat and a read by path,
        // another stealer's fresh lock could be paired with the stale age.
        const { age, text } = readLockFile(lockPath)
        holder = text
        // Abandoned (crashed agent, killed process): take it over.
        if (age > options.staleMs || isHolderDead(holder)) {
          stealLock(lockPath, holder, options.staleMs)
          continue
        }
      } catch {
        continue // vanished between our checks: retry immediately
      }
      if (Date.now() > deadline) throw new LockTimeoutError(file, holder)
      sleepSync(15 + Math.floor(Math.random() * 35))
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8').includes(token)) unlinkSync(lockPath)
    } catch {
      // already released or stolen as stale
    }
  }
}

function readLockFile(lockPath: string): { age: number; text: string } {
  const fd = openSync(lockPath, 'r')
  try {
    const age = Date.now() - fstatSync(fd).mtimeMs
    return { age, text: readFileSync(fd, 'utf8') }
  } finally {
    closeSync(fd)
  }
}

/**
 * True when the lock names a process on this machine that no longer exists.
 * A lock from another host, or one still being written (empty), is never
 * judged dead: only its age can release it.
 */
function isHolderDead(holder: string): boolean {
  let token = ''
  try {
    token = String((JSON.parse(holder) as { token?: unknown }).token ?? '')
  } catch {
    return false
  }
  const match = /^(\d+)@(.+):[0-9a-f]+$/.exec(token)
  if (!match || match[2] !== hostname()) return false
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Removes an abandoned lock, but only the one that was judged abandoned.
 * Stealers serialize on `<lock>.steal` (O_EXCL) and re-read the lock under it:
 * without that, a second stealer that saw the same stale lock could delete
 * the first stealer's fresh lock, and both would enter.
 */
function stealLock(lockPath: string, staleHolder: string, staleMs: number): void {
  const guard = `${lockPath}.steal`
  try {
    closeSync(openSync(guard, 'wx'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Another stealer is at work (it needs microseconds). A guard that old
    // was left by a stealer that died in between: clear it.
    try {
      if (Date.now() - statSync(guard).mtimeMs > Math.min(staleMs, 2_000)) unlinkSync(guard)
    } catch {
      // gone already
    }
    sleepSync(5)
    return
  }
  try {
    if (readText(lockPath) === staleHolder) unlinkSync(lockPath)
  } catch {
    // released meanwhile
  } finally {
    try {
      unlinkSync(guard)
    } catch {
      // cleared by someone who judged us dead
    }
  }
}

/** Reads a file, '' when missing. */
export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Writes `text` to `file` atomically (temp file + fsync + rename). */
export function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp)
    throw error
  }
}

/**
 * Read-modify-write under the file's lock. `fn` gets the current text and
 * returns the new text; returning the same text skips the write.
 */
export function mutateFile(file: string, options: LockOptions, fn: (text: string) => string): string {
  return withLock(file, options, () => {
    const before = readText(file)
    const after = fn(before)
    if (after !== before) atomicWrite(file, after)
    return after
  })
}

/** Appends a block to an append-only stream under the file's lock. */
export function appendBlock(file: string, options: LockOptions, block: string, header = '', tight = false): void {
  withLock(file, options, () => {
    mkdirSync(dirname(file), { recursive: true })
    const current = readText(file)
    let prefix = ''
    if (current === '') prefix = header
    else if (tight) prefix = current.endsWith('\n') ? '' : '\n'
    else if (!current.endsWith('\n\n')) prefix = current.endsWith('\n') ? '\n' : '\n\n'
    appendFileSync(file, prefix + block.trimEnd() + '\n')
  })
}
