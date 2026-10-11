#!/usr/bin/env node
import { isCoordinationError, isUsageError, run } from './commands/run.ts'

const argv = process.argv.slice(2)
const json = argv.includes('--json')

try {
  const result = await run(argv)
  if (result !== 'stream') {
    process.stdout.write((json ? JSON.stringify(result.data, null, 2) : result.text) + '\n')
  }
} catch (error) {
  const message = (error as Error).message
  // Exit 2: refused by the protocol (task owned by someone else, unknown id).
  // Exit 64: bad usage. Exit 1: anything else.
  const code = isCoordinationError(error) ? 2 : isUsageError(error) ? 64 : 1
  if (json) process.stdout.write(JSON.stringify({ error: message, code }) + '\n')
  process.stderr.write(`wsc: ${message}\n`)
  process.exitCode = code
}
