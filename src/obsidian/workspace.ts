import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, registryPath } from '../config/config.ts'
import { readRegistry } from '../config/projects.ts'
import type { ResolvedConfig } from '../config/config.ts'
import { formatEventLine, humanTime, isoNow, newEventId } from '../events/format.ts'
import { appendBlock, atomicWrite, mutateFile, readText, withLock } from '../filesystem/atomic.ts'
import type { LockOptions } from '../filesystem/atomic.ts'
import { countTasks, isAgentOnline } from '../dashboard/model.ts'
import type { WorkspaceEvent, WorkspaceEventType, WorkspaceSnapshot } from '../types.ts'
import { setRegion } from './markdown.ts'
import { buildSnapshot, SNAPSHOT_FILES, snapshotPaths } from './snapshot.ts'
import type { SnapshotFile } from './snapshot.ts'

/** Root of the installed package (holds AGENT_PROTOCOL.md). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const HEADERS: Record<string, (project: string) => string> = {
  agents: p =>
    `# Agents · ${p}\n\nOne section per agent. An agent edits only its own section.\nProtocol: [[AGENT_PROTOCOL]]\n`,
  tasks: p =>
    `# Tasks · ${p}\n\nClaim a task by setting \`Owner\` to your agent ID and \`Status\` to IN_PROGRESS.\nNever take a task another online agent owns. Protocol: [[AGENT_PROTOCOL]]\n`,
  requests: p =>
    `# Requests · ${p}\n\nQuestions between agents. Answer by appending \`### Answer — <Agent-ID> · <time>\` and setting \`Status: ANSWERED\`.\n`,
  messages: p => `# Messages · ${p}\n\nAppend-only. Never edit or delete another agent's message.\n`,
  milestones: p => `# Milestones · ${p}\n\nAppend-only.\n`,
  commits: p => `# Commits · ${p}\n\nAppend-only. One line per commit: hash · subject · agent · branch · time.\n`,
  sessionLog: p =>
    `# Session Log · ${p}\n\nAppend-only event stream. Each entry carries a machine-readable WC_EVENT block.\n`,
  plan: p => `# Current Plan · ${p}\n\nNo plan yet. Create one with \`wsc plan create\` or by editing this file.\n`,
}

export interface Identity {
  agent: string
  session: string
}

export class Workspace {
  readonly resolved: ResolvedConfig
  readonly root: string
  readonly lockOptions: LockOptions

  constructor(resolved: ResolvedConfig, owner = '') {
    this.resolved = resolved
    this.root = resolved.workspace
    this.lockOptions = {
      lockDir: join(this.root, '.wc', 'locks'),
      staleMs: resolved.config.lockStaleMs,
      owner,
    }
  }

  /** `register`: record a not yet registered project in projects.json (writes only). */
  static open(cwd: string = process.cwd(), configPath?: string, owner = '', options: { register?: boolean } = {}): Workspace {
    return new Workspace(loadConfig(cwd, configPath, options), owner)
  }

  get project(): string {
    return this.resolved.project
  }

  path(name: keyof ResolvedConfig['files']): string {
    return join(this.root, this.resolved.files[name])
  }

  sessionFile(agent: string): string {
    return join(this.root, this.resolved.files.sessionsDir, `${agent.replace(/[^\w.-]/g, '_')}.md`)
  }

  statePath(): string {
    return join(this.root, '.wc', 'state.json')
  }

  /** Creates the folder structure and any missing file; never overwrites content. */
  init(): { created: string[] } {
    const created: string[] = []
    mkdirSync(join(this.root, this.resolved.files.sessionsDir), { recursive: true })
    mkdirSync(join(this.root, '.wc', 'locks'), { recursive: true })
    for (const [key, header] of Object.entries(HEADERS)) {
      const file = this.path(key as keyof ResolvedConfig['files'])
      if (this.createIfMissing(file, header(this.project))) created.push(file)
    }
    const notes = this.path('projectNotes')
    if (this.createIfMissing(notes, this.projectNotesTemplate())) created.push(notes)
    const protocolTarget = this.path('protocol')
    const protocolSource = join(PACKAGE_ROOT, 'AGENT_PROTOCOL.md')
    if (existsSync(protocolSource)) {
      const source = readFileSync(protocolSource, 'utf8')
      const current = readText(protocolTarget)
      // The protocol copy is generated: refresh it when the package's changes,
      // unless a human removed the generated marker to keep local edits.
      if (current === '' || (current !== source && current.includes('<!-- wc:generated -->'))) {
        // Edits made while the marker was still there are kept, not lost.
        if (current !== '') this.backup(protocolTarget, current)
        atomicWrite(protocolTarget, source)
        if (current === '') created.push(protocolTarget)
      }
    }
    this.refreshNotes()
    if (this.resolved.registration) this.refreshProjectIndex()
    return { created }
  }

  /** Saves a copy of a note before it is regenerated, under `.wc/backups/`. */
  private backup(file: string, text: string): void {
    const stamp = isoNow().replace(/[:+]/g, '-')
    atomicWrite(join(this.root, '.wc', 'backups', `${basename(file)}.${stamp}.bak`), text)
  }

  /**
   * Keeps PROJECTS.md, next to the project folders, listing every registered
   * project and the repositories that resolve to it, so agents without the CLI
   * can find a repository's workspace. Only the generated block is written.
   */
  refreshProjectIndex(): void {
    const { vault, config } = this.resolved
    const base = join(vault, config.workspaceDir)
    const index = join(base, 'PROJECTS.md')
    const rows = Object.entries(readRegistry(registryPath()).projects)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, p]) => {
        const folder = p.workspaceDir.startsWith('/') ? p.workspaceDir : join(vault, p.workspaceDir)
        const rel = folder === base ? '.' : folder.startsWith(`${base}/`) ? folder.slice(base.length + 1) : folder
        const notes = rel === '.' ? config.projectNotes : `${rel}/${config.projectNotes}`
        return `| [[${notes.replace(/\.md$/, '')}\\|${p.name}]] | \`${rel}\` | ${p.roots.map(r => `\`${r}\``).join('<br>') || '-'} |`
      })
    const table = ['| Project | Workspace folder | Repositories |', '| --- | --- | --- |', ...rows].join('\n')
    mutateFile(index, { ...this.lockOptions, lockDir: join(base, '.wc', 'locks') }, text => {
      const current =
        text ||
        `# Projects\n\nEvery project has its own workspace folder. An agent working in a repository uses the folder listed for it.\nWrite your own notes outside the generated block.\n\n<!-- wc:projects:start -->\n<!-- wc:projects:end -->\n`
      return setRegion(current, 'projects', table)
    })
  }

  private createIfMissing(file: string, content: string): boolean {
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(file, content, { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  private projectNotesTemplate(): string {
    const f = this.resolved.files
    const link = (name: string) => `[[${name.replace(/\.md$/, '')}]]`
    return [
      `# ${this.project}`,
      '',
      'Shared workspace for every agent working on this project, maintained by Workspace Commander.',
      'Write your own notes anywhere outside the generated status block.',
      '',
      '<!-- wc:status:start -->',
      '<!-- wc:status:end -->',
      '',
      '## Workspace',
      '',
      `- ${link(f.plan)} — the current plan`,
      `- ${link(f.tasks)} — tasks and their owners`,
      `- ${link(f.agents)} — who is working on what`,
      `- ${link(f.requests)} — questions between agents`,
      `- ${link(f.messages)} — messages between agents`,
      `- ${link(f.milestones)} — milestones reached`,
      `- ${link(f.commits)} — commits made`,
      `- ${link(f.sessionLog)} — every event, append-only`,
      `- ${link(f.protocol)} — how any AI agent participates`,
      '',
      '## Notes',
      '',
      '',
    ].join('\n')
  }

  readTexts(): Partial<Record<SnapshotFile, string>> {
    const paths = snapshotPaths(this.root, this.resolved.files)
    const texts: Partial<Record<SnapshotFile, string>> = {}
    for (const key of SNAPSHOT_FILES) texts[key] = readText(paths[key])
    return texts
  }

  snapshot(): WorkspaceSnapshot {
    return buildSnapshot(this.project, this.root, this.readTexts())
  }

  mutate(name: keyof ResolvedConfig['files'], fn: (text: string) => string): string {
    return mutateFile(this.path(name), this.lockOptions, fn)
  }

  /** Locked read-then-append: `build` sees the current text (to allocate ids). */
  appendRecord(name: keyof ResolvedConfig['files'], build: (current: string) => string): void {
    const file = this.path(name)
    withLock(file, this.lockOptions, () => {
      const current = readText(file)
      const built = build(current).trimEnd()
      if (built === '') return // nothing to append (e.g. an already-recorded commit)
      const block = built + '\n'
      const header = HEADERS[name]?.(this.project) ?? ''
      let prefix = ''
      if (current === '') prefix = header ? `${header}\n` : ''
      else if (!current.endsWith('\n\n')) prefix = current.endsWith('\n') ? '\n' : '\n\n'
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, prefix + block)
    })
  }

  /** Appends an event to SESSION_LOG.md and the agent's session journal, then refreshes notes. */
  emit(
    identity: Identity,
    type: WorkspaceEventType,
    summary: string,
    ref?: string,
    options: { refreshNotes?: boolean } = {},
  ): WorkspaceEvent {
    const event: WorkspaceEvent = {
      id: newEventId(),
      type,
      agent: identity.agent,
      session: identity.session,
      timestamp: isoNow(),
      ...(ref ? { ref } : {}),
      summary,
    }
    appendBlock(this.path('sessionLog'), this.lockOptions, formatEventLine(event), `${HEADERS.sessionLog?.(this.project)}\n`)
    if (identity.agent && identity.agent !== 'external') {
      const journal = this.sessionFile(identity.agent)
      appendBlock(
        journal,
        this.lockOptions,
        `- ${humanTime(event.timestamp)} · ${type} · ${summary}`,
        `# Session journal · ${identity.agent}\n\nWritten only by ${identity.agent}.\n\n`,
        true,
      )
    }
    if (options.refreshNotes !== false) this.refreshNotes()
    return event
  }

  /** Rewrites the generated status block of ProjectNotes.md, keeping human text. */
  refreshNotes(): void {
    const snap = this.snapshot()
    const now = Date.now()
    const counts = countTasks(snap.tasks)
    const online = snap.agents.filter(a => isAgentOnline(a, now, this.resolved.config.staleAgentMinutes))
    const open = snap.requests.filter(r => r.status === 'OPEN')
    const lastMilestone = snap.milestones.at(-1)
    const lines = [
      '## Status',
      '',
      `_Updated ${humanTime(isoNow())} by Workspace Commander._`,
      '',
      `| Completed | Ongoing | Pending | Blocked |`,
      `| --- | --- | --- | --- |`,
      `| ${counts.completed} | ${counts.ongoing} | ${counts.pending} | ${counts.blocked} |`,
      '',
      `**Agents online:** ${online.length ? online.map(a => `${a.id} (${a.status})`).join(', ') : 'none'}`,
      '',
      `**Open requests:** ${open.length ? open.map(r => `${r.id} → ${r.to}`).join(', ') : 'none'}`,
      '',
      `**Last milestone:** ${lastMilestone ? `${lastMilestone.title} (${lastMilestone.agent})` : 'none'}`,
    ]
    this.mutate('projectNotes', text => {
      const base = text === '' ? this.projectNotesTemplate() : text
      return setRegion(base, 'status', lines.join('\n'))
    })
  }

  readState(): Record<string, unknown> {
    try {
      return JSON.parse(readText(this.statePath()) || '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  }

  updateState(fn: (state: Record<string, unknown>) => Record<string, unknown>): void {
    const file = this.statePath()
    withLock(file, this.lockOptions, () => {
      let state: Record<string, unknown> = {}
      try {
        state = JSON.parse(readText(file) || '{}') as Record<string, unknown>
      } catch {
        state = {}
      }
      atomicWrite(file, JSON.stringify(fn(state), null, 2) + '\n')
    })
  }

  currentBranch(): string {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.resolved.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return ''
    }
  }
}
