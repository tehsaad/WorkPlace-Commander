import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
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
 *   one process can hold one. A lock older than `staleMs` is assumed abandoned
 *   (crashed agent) and taken over. The `.wc` folder is hidden from Obsidian.
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
        const age = Date.now() - statSync(lockPath).mtimeMs
        holder = readFileSync(lockPath, 'utf8')
        if (age > options.staleMs) {
          // Abandoned: take it over. Unlink is racy between two stealers, but
          // the next openSync('wx') still admits only one of them.
          unlinkSync(lockPath)
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
