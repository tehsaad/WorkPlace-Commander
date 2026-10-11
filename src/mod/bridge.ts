/**
 * Pure helpers for the hooks module's host access.
 *
 * The engine's static analysis allows `$` to flow only into functions declared
 * in the hooks module itself, never across an import. So everything here is
 * pure: argv builders and output parsers. hooks/register.tsx does the `$`
 * calls with them.
 *
 * Reads go through `$.fs.read` plus the shared parsers (no process per
 * refresh). Writes go through the `wsc` CLI via `$.process.run`, because the
 * hooks sandbox has no append, rename or exclusive-create: the CLI is where
 * locking and atomic writes happen.
 */
import { buildSnapshot } from '../obsidian/snapshot.ts'
import type { SnapshotFile } from '../obsidian/snapshot.ts'
import type { WcCommit, WcSelf, WcSnapshot } from '../../types'

export interface WscResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** 2: refused by the protocol; 64: usage; 1: failure. */
  code: number
}

export function cliPathOf(pluginRoot: string): string {
  return `${pluginRoot}/dist/cli.js`
}

/** The argv of `wsc <args> --json` with this agent's identity. */
export function wscArgv(
  node: string,
  pluginRoot: string,
  args: readonly string[],
  self?: Pick<WcSelf, 'agentId' | 'session'> | null,
): string[] {
  const identity = self ? ['--agent', self.agentId, '--session', self.session] : []
  return [node, cliPathOf(pluginRoot), ...args, ...identity, '--json']
}

/** Interprets a finished `wsc --json` run. */
export function parseWscRun<T>(run: { exitCode: number; stdout: string; stderr: string }): WscResult<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    parsed = undefined
  }
  if (run.exitCode === 0) return { ok: true, data: parsed as T, code: 0 }
  const error = (parsed as { error?: string } | undefined)?.error ?? (run.stderr.trim() || `wsc exited with ${run.exitCode}`)
  return { ok: false, error: error.replace(/^wsc: /, ''), code: run.exitCode }
}

/** Parses `git log --oneline` output. */
export function parseOneline(stdout: string): WcCommit[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const space = line.indexOf(' ')
      return space === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, space), subject: line.slice(space + 1) }
    })
}

export function snapshotFromTexts(self: WcSelf, texts: Partial<Record<SnapshotFile, string>>): WcSnapshot {
  return buildSnapshot(self.project, self.workspace, texts) as WcSnapshot
}

/** A message for a failed registration: "not built" gets the fix spelled out. */
export function connectError(error: string | undefined, pluginRoot: string): string {
  const missing = /Cannot find module|ENOENT|could not run|MODULE_NOT_FOUND/.test(error ?? '')
  return missing
    ? `Workspace Commander is not built: run \`npm install && npm run build\` in ${pluginRoot}`
    : `Workspace Commander: ${error ?? 'unknown error'}`
}
