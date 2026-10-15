// One contender for a file lock, run as its own process by the tests.
//
//   node lock-worker.mjs <lockDir> <counterFile> <startAtMs> <staleMs>
//
// Waits until <startAtMs> so every contender starts at once, then increments
// the counter under the lock while holding an "inside" marker created with
// O_EXCL: a second process inside the critical section is a violation.
import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import { withLock } from '../../dist/index.js'

const [lockDir, counter, startAt, staleMs] = process.argv.slice(2)
while (Date.now() < Number(startAt)) {
  // spin: a timer would spread the start over several milliseconds
}
let violation = false
withLock(counter, { lockDir, staleMs: Number(staleMs), timeoutMs: 20_000 }, () => {
  const marker = `${counter}.inside`
  try {
    closeSync(openSync(marker, 'wx'))
  } catch {
    violation = true
  }
  const value = Number(readFileSync(counter, 'utf8') || '0')
  const until = Date.now() + 25
  while (Date.now() < until) {
    // hold the lock long enough for a racing stealer to overlap
  }
  writeFileSync(counter, String(value + 1))
  if (!violation) unlinkSync(marker)
})
process.stdout.write(JSON.stringify({ violation }) + '\n')
