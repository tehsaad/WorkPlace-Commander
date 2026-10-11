import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ResolvedConfig } from '../config/config.ts'
import { atomicWrite } from '../filesystem/atomic.ts'
import { setRegion } from '../obsidian/markdown.ts'
import { isoNow } from '../events/format.ts'

/**
 * One-time setup for AI tools that do not run Workspace Commander
 * (Antigravity, Cursor, Codex, Gemini CLI, ...): a short standing instruction
 * the tool loads into every chat by itself, so nobody repeats it per chat.
 */
export const AGENT_TARGETS: Record<string, { kind: string; where: string }> = {
  antigravity: {
    kind: 'antigravity',
    where:
      'Antigravity: Agent panel → … → Customizations → Rules → "+ Global" (stored in ~/.gemini/GEMINI.md), or a workspace rule file in <repo>/.agent/rules/.',
  },
  cursor: { kind: 'cursor', where: 'Cursor: Settings → Rules → User Rules, or a project rule in <repo>/.cursor/rules/.' },
  codex: { kind: 'codex', where: 'Codex CLI: ~/.codex/AGENTS.md (global) or AGENTS.md at the repository root.' },
  gemini: { kind: 'gemini-cli', where: 'Gemini CLI: ~/.gemini/GEMINI.md (global) or GEMINI.md at the repository root.' },
  generic: { kind: 'agent', where: "Any agent: its global or per-project instruction file (often AGENTS.md)." },
}

export function agentSetupSnippet(resolved: ResolvedConfig, tool: string, id: string): string {
  const base = join(resolved.vault, resolved.config.workspaceDir)
  const kind = AGENT_TARGETS[tool]?.kind ?? tool
  return [
    '## Workspace Commander (shared multi-agent workspace)',
    '',
    `You work alongside other AI agents (Claude Code sessions and others) through Markdown files in an Obsidian vault. Your agent ID is **${id}** (kind \`${kind}\`); use it in every session.`,
    '',
    `1. At the start of every task, open \`${join(base, 'PROJECTS.md')}\` and find the workspace folder listed for the repository you are working in. If the repository is not listed, use \`${resolved.workspace}\`.`,
    '2. In that folder, read `AGENT_PROTOCOL.md` and follow it. Register or refresh your section in `AGENTS.md`, then read `PLAN.md`, `TASKS.md`, `REQUESTS.md`, and the messages in `MESSAGES.md` addressed to you or `ALL`.',
    '3. Claim a task in `TASKS.md` before working on it, and never take a task another online agent owns. Answer requests addressed to you. Before each step, and while you wait on a request, re-read `MESSAGES.md`, `REQUESTS.md`, and `TASKS.md`.',
    '4. Only append or edit single fields. Never delete or rewrite other agents\' content or human notes.',
    `5. If you can run shell commands, prefer the helper CLI, which locks files for you: \`wsc <command> --agent ${id}\` run in the repository (\`wsc --help\`).`,
    '',
  ].join('\n')
}

/**
 * Writes the snippet into `file` between `wc:agent-setup` markers. Anything
 * else in the file is kept, and an existing file is copied to `<file>.bak-<time>` first.
 */
export function writeAgentSetup(file: string, snippet: string): { file: string; backup?: string } {
  mkdirSync(dirname(file), { recursive: true })
  let backup: string | undefined
  let current = ''
  if (existsSync(file)) {
    current = readFileSync(file, 'utf8')
    backup = `${file}.bak-${isoNow().replace(/[:+]/g, '-')}`
    copyFileSync(file, backup)
  }
  atomicWrite(file, setRegion(current, 'agent-setup', snippet))
  return { file, ...(backup ? { backup } : {}) }
}
