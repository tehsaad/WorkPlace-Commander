/**
 * Workspace Commander: the Claude Code mod.
 *
 * The engine lets `$` flow only into functions declared in this file, so every
 * host call is here; the logic it calls is pure and lives in ../src:
 *   src/mod/bridge.ts     wsc argv building and output parsing
 *   src/mod/dashboard.tsx the pane's tree
 *   src/mod/tools.ts      the tools Claude calls
 *   src/mod/inbox.ts      what is new for this agent
 *   src/obsidian, src/dashboard, src/events: protocol code shared with the CLI
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { buildDashboard } from '../src/dashboard/model.ts'
import { renderTextDashboard } from '../src/dashboard/text.ts'
import { SNAPSHOT_FILES, snapshotPaths } from '../src/obsidian/snapshot.ts'
import type { SnapshotFile } from '../src/obsidian/snapshot.ts'
import { cliPathOf, connectError, parseOneline, parseWscRun, snapshotFromTexts, wscArgv } from '../src/mod/bridge.ts'
import type { WscResult } from '../src/mod/bridge.ts'
import { renderDashboard } from '../src/mod/dashboard.tsx'
import { diffInbox, diffTasks, EMPTY_SEEN, formatBriefing, formatInbox, itemKey } from '../src/mod/inbox.ts'
import type { InboxItem, Seen } from '../src/mod/inbox.ts'
import { PANE_TITLE, PLUGIN, STORE } from '../src/mod/state.ts'
import { TOOLS } from '../src/mod/tools.ts'
import type { WcFiles, WcSelf } from '../types'

type Engine = EngineInterface

// Session state the dashboard draws from: held by the host, so it survives hot
// reloads; gitVisible and the session start are mirrored to $.store as well.
const selfAtom = atom({ plugin: 'workspace-commander', key: 'self' } as const, null)
const snapshotAtom = atom({ plugin: 'workspace-commander', key: 'snapshot' } as const, null)
const commitsAtom = atom({ plugin: 'workspace-commander', key: 'commits' } as const, [])
const gitVisibleAtom = atom({ plugin: 'workspace-commander', key: 'gitVisible' } as const, true)
const nowAtom = atom({ plugin: 'workspace-commander', key: 'now' } as const, 0)
const liveAtom = atom({ plugin: 'workspace-commander', key: 'live' } as const, false)
const errorAtom = atom({ plugin: 'workspace-commander', key: 'error' } as const, null)

const HEARTBEAT_MS = 120_000
const POLL_MS = 2_000
const COMMIT_SYNC_DELAY_MS = 3_000
const TOOL_PREFIX = `mcp__${PLUGIN}__`
const PANE_ID = 'workspace-commander'

interface RegisterData {
  agent: { id: string; session: string }
  resumed: boolean
  workspace: string
  project: string
  files: WcFiles
  config: { staleAgentMinutes: number; gitLogCount: number; autoWake: boolean }
}

/**
 * Module-level runtime. It resets on every hot reload; durable values live in
 * $.state (the session's) and $.store (across sessions).
 */
const rt = {
  ready: Promise.resolve(null) as Promise<WcSelf | null>,
  isBusy: false,
  pending: [] as InboxItem[],
  /** The seen-marker to store once `pending` has been handed to the model. */
  pendingSeen: undefined as Seen | undefined,
  /** Startup briefing, given with the first prompt (or first tool result). */
  briefing: undefined as string | undefined,
  lastHeartbeat: 0,
  refreshTimer: undefined as { cancel: () => void } | undefined,
  syncTimer: undefined as { cancel: () => void } | undefined,
  isStopped: false,
}

// ---------------------------------------------------------------- host access

/**
 * Runs background work without awaiting it. A late rejection (the module was
 * reloaded or the session ended underneath it) is expected and dropped.
 */
function detach(work: Promise<unknown> | undefined | null | false): void {
  if (work) work.catch(() => undefined)
}

/** Runs `wsc <args> --json` on the host. Never throws. */
async function wsc<T = unknown>(
  $: Engine,
  args: readonly string[],
  options: { cwd: string; self?: WcSelf | null; timeoutMs?: number },
): Promise<WscResult<T>> {
  const node = (await $.env.get('WSC_NODE')) || 'node'
  try {
    const run = await $.process.run(wscArgv(node, $.plugin.root, args, options.self), {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 20_000,
    })
    return parseWscRun<T>(run)
  } catch (error) {
    return { ok: false, error: `could not run wsc: ${(error as Error).message}`, code: 1 }
  }
}

async function readText($: Engine, path: string): Promise<string> {
  try {
    return (await $.fs.read(path)) as string
  } catch {
    return ''
  }
}

async function gitLog($: Engine, self: WcSelf) {
  try {
    const run = await $.process.run(['git', 'log', '--oneline', '-n', String(self.gitLogCount)], {
      cwd: self.cwd,
      timeoutMs: 10_000,
    })
    return run.exitCode === 0 ? parseOneline(run.stdout) : []
  } catch {
    return []
  }
}

async function mtime($: Engine, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------- workspace

async function connect($: Engine, cwd: string): Promise<WcSelf | null> {
  const session = await $.session.id()
  const explicitId = (await $.env.get('WSC_AGENT')) || (await continuedId($, session))
  const result = await wsc<RegisterData>(
    $,
    ['agent', 'register', '--kind', 'claude-code', '--session', session, ...(explicitId ? ['--id', explicitId] : [])],
    { cwd },
  )
  if (!result.ok || !result.data) {
    const message = connectError(result.error, $.plugin.root)
    await update($, errorAtom, () => message)
    $.ui.status(message)
    return null
  }
  const data = result.data
  // The session timer survives hot reloads and restarts of the same session.
  const startKey = STORE.sessionStart(session)
  const storedStart = await $.store.get(startKey)
  const startedAt = typeof storedStart === 'number' ? storedStart : Date.now()
  if (typeof storedStart !== 'number') await $.store.set(startKey, startedAt)
  const self: WcSelf = {
    agentId: data.agent.id,
    session,
    cwd,
    workspace: data.workspace,
    project: data.project,
    files: data.files,
    staleMinutes: data.config.staleAgentMinutes,
    gitLogCount: data.config.gitLogCount,
    autoWake: data.config.autoWake,
    startedAt,
  }
  await update($, selfAtom, () => self)
  await update($, errorAtom, () => null)
  $.ui.status(`${self.agentId} · ${self.project}`)
  await Promise.all([refreshWorkspace($, self, true), refreshGit($, self)])
  const snapshot = await read($, snapshotAtom)
  if (snapshot) {
    // The startup items go into the briefing instead of a separate note.
    rt.briefing = formatBriefing(self, snapshot, rt.pending, Date.now())
    rt.pending = []
  }
  return self
}

/**
 * The agent id to keep when this process goes on under a new session id
 * (resume, fork): the conversation is the same agent, not a new one. Only
 * while AGENTS.md still gives that id to our previous session; an id another
 * session took over is never taken back.
 */
async function continuedId($: Engine, session: string): Promise<string | undefined> {
  const [previous, snapshot] = await Promise.all([read($, selfAtom), read($, snapshotAtom)])
  if (!previous || previous.session === session) return undefined
  const record = snapshot?.agents.find(a => a.id === previous.agentId)
  return record?.session === previous.session ? previous.agentId : undefined
}

/**
 * Hands the briefing and pending items to the model, and only then marks them
 * read, so an item is never counted as seen without having been delivered.
 */
async function takePending($: Engine, self: WcSelf | null): Promise<string | undefined> {
  const parts: string[] = []
  if (rt.briefing) parts.push(rt.briefing)
  if (rt.pending.length) parts.push(formatInbox(rt.pending, self?.agentId ?? 'you', self?.files.messages))
  rt.briefing = undefined
  rt.pending = []
  if (self && rt.pendingSeen) await $.store.set(STORE.seen(self.workspace, self.agentId), rt.pendingSeen)
  rt.pendingSeen = undefined
  return parts.length ? parts.join('\n\n') : undefined
}

/** Re-reads the Markdown, publishes the snapshot, and surfaces what is new. */
async function refreshWorkspace($: Engine, self: WcSelf, isInitial = false): Promise<void> {
  const paths = snapshotPaths(self.workspace, self.files)
  const texts: Partial<Record<SnapshotFile, string>> = {}
  await Promise.all(SNAPSHOT_FILES.map(async key => void (texts[key] = await readText($, paths[key]))))
  const snapshot = snapshotFromTexts(self, texts)
  const before = isInitial ? null : await read($, snapshotAtom)
  await update($, snapshotAtom, () => snapshot)

  // A new agent id starts from nothing seen: what is already addressed to it
  // is delivered (the briefing counts and points to older messages), never
  // marked read unseen. The marker is stored only on delivery (takePending).
  const stored = ((await $.store.get(STORE.seen(self.workspace, self.agentId))) as Seen | undefined) ?? EMPTY_SEEN
  const { items: found, seen } = diffInbox(snapshot, self.agentId, stored)
  rt.pendingSeen = seen
  const queued = new Set(rt.pending.map(itemKey))
  const items = [...found, ...diffTasks(before, snapshot, self.agentId)].filter(i => !queued.has(itemKey(i)))
  if (items.length === 0) return
  rt.pending = [...rt.pending, ...items]
  if (isInitial) return
  const first = items[0]!
  $.ui.toast(items.length === 1 ? `Workspace: ${first.kind} ${first.id} from ${first.from}` : `Workspace: ${items.length} new items`)
  // Wake an idle session for things addressed to this agent; anything else
  // rides along with the next prompt (prompt.submit below).
  if (self.autoWake && !rt.isBusy && items.some(i => i.isDirect)) {
    const text = await takePending($, self)
    if (!text) return
    rt.isBusy = true
    detach(
      $.prompt.submit({ text }).catch(() => {
        rt.isBusy = false
      }),
    )
  }
}

async function refreshGit($: Engine, self: WcSelf): Promise<void> {
  const commits = await gitLog($, self)
  await update($, commitsAtom, () => commits)
}

function scheduleRefresh($: Engine, kind: 'workspace' | 'git'): void {
  if (kind === 'git') {
    detach(rt.ready.then(self => self && refreshGit($, self)))
    // Commits made outside any agent are recorded a moment later, once the
    // committing agent had the chance to record (and attribute) its own.
    rt.syncTimer?.cancel()
    rt.syncTimer = $.clock.after(COMMIT_SYNC_DELAY_MS, () => {
      detach(rt.ready.then(self => self && wsc($, ['commit', 'sync'], { cwd: self.cwd, self })))
    })
    return
  }
  rt.refreshTimer?.cancel()
  rt.refreshTimer = $.clock.after(100, () => {
    detach(rt.ready.then(self => self && refreshWorkspace($, self)))
  })
}

/** Native file watching (inotify/FSEvents) through a `wsc watch` child; polling if it fails. */
function startWatcher($: Engine, self: WcSelf): void {
  detach((async () => {
    try {
      const node = (await $.env.get('WSC_NODE')) || 'node'
      const stream = $.process.spawn({ argv: [node, cliPathOf($.plugin.root), 'watch'], cwd: self.cwd })
      let buffer = ''
      for await (const chunk of stream) {
        if (rt.isStopped) break
        buffer += chunk.text
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.startsWith('{')) continue
          const event = JSON.parse(line) as { type: string }
          if (event.type === 'ready') await update($, liveAtom, () => true)
          else if (event.type === 'workspace' || event.type === 'git') scheduleRefresh($, event.type)
        }
      }
    } catch (error) {
      $.ui.log(`Workspace Commander watcher stopped: ${(error as Error).message}`, { to: 'debug' })
    }
    if (rt.isStopped) return
    await update($, liveAtom, () => false)
    startPolling($, self)
  })())
}

/** Fallback: compares mtimes every 2 s through $.fs.stat (no processes). */
function startPolling($: Engine, self: WcSelf): void {
  const paths = Object.values(snapshotPaths(self.workspace, self.files))
  let gitHead: string | undefined
  detach(
    $.process.run(['git', 'rev-parse', '--absolute-git-dir'], { cwd: self.cwd, timeoutMs: 10_000 }).then(run => {
      if (run.exitCode === 0) gitHead = `${run.stdout.trim()}/logs/HEAD`
    }),
  )
  const marks = new Map<string, number>()
  const changed = async (path: string) => {
    const m = await mtime($, path)
    const was = marks.get(path)
    marks.set(path, m)
    return was !== undefined && was !== m
  }
  $.clock.every(POLL_MS, () => {
    detach((async () => {
      let isWorkspaceChanged = false
      for (const path of paths) if (await changed(path)) isWorkspaceChanged = true
      if (isWorkspaceChanged) scheduleRefresh($, 'workspace')
      if (gitHead && (await changed(gitHead))) scheduleRefresh($, 'git')
    })())
  })
  $.ui.log('Workspace Commander: native watching unavailable, polling every 2s', { to: 'debug' })
}

/**
 * Refreshes this agent's Last Activity (and lets the CLI mark stale agents
 * offline). Runs on a timer as well as after tool calls, so a session idling
 * at the prompt is never mistaken for a dead one. If the record now belongs to
 * another session (this one was marked offline while suspended and its id was
 * reused), registers again for a fresh id.
 */
async function beat($: Engine, self: WcSelf): Promise<void> {
  rt.lastHeartbeat = Date.now()
  const result = await wsc<{ session?: string }>($, ['agent', 'heartbeat'], { cwd: self.cwd, self })
  if (rt.isStopped || !result.ok || !result.data?.session || result.data.session === self.session) return
  $.ui.log(`Workspace Commander: ${self.agentId} was taken over by session ${result.data.session}; registering again`, { to: 'debug' })
  rt.ready = connect($, self.cwd)
}

/** Flips the Git panel. /togglegit and the pane's button both call this. */
async function toggleGit($: Engine): Promise<boolean> {
  let isVisible = true
  await update($, gitVisibleAtom, visible => {
    isVisible = !visible
    return isVisible
  })
  await $.store.set(STORE.gitVisible, isVisible)
  return isVisible
}

async function statusText($: Engine, self: WcSelf, columns = 100): Promise<string> {
  const [snapshot, commits, gitVisible] = await Promise.all([read($, snapshotAtom), read($, commitsAtom), read($, gitVisibleAtom)])
  if (!snapshot) return 'No workspace snapshot yet.'
  const model = buildDashboard(snapshot, { now: Date.now(), self: self.agentId, staleMinutes: self.staleMinutes, commits })
  const mine = snapshot.requests.filter(r => r.status === 'OPEN' && r.to === self.agentId)
  const toMe = snapshot.messages.filter(m => m.to === self.agentId).slice(-3)
  const extra = [
    `You are ${self.agentId}. Workspace: ${self.workspace}`,
    mine.length ? `Open requests for you: ${mine.map(r => `${r.id} from ${r.from}: ${r.question}`).join(' | ')}` : '',
    toMe.length ? `Latest messages to you: ${toMe.map(m => `${m.id} from ${m.from}: ${m.body}`).join(' | ')}` : '',
    snapshot.plan && !/No plan yet\./.test(snapshot.plan) ? `\n${snapshot.plan.trim()}` : 'No plan yet.',
  ].filter(Boolean)
  const board = renderTextDashboard(model, {
    width: Math.min(columns, 110),
    elapsedMs: Date.now() - self.startedAt,
    showGit: gitVisible,
  })
  return `${board}\n${extra.join('\n')}`
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    rt.isStopped = false
    await $.command.register({
      name: 'togglegit',
      description: 'Show or hide the Git panel of the Workspace Commander dashboard',
      immediate: true,
    })
    await $.command.register({
      name: 'wc',
      description: 'Workspace Commander: open the dashboard, `/wc status` to print it, `/wc refresh`',
      argumentHint: '[open|status|refresh]',
      immediate: true,
    })
    for (const tool of Object.values(TOOLS)) await $.tool.register(tool.spec)

    const storedGit = await $.store.get(STORE.gitVisible)
    if (typeof storedGit === 'boolean') await update($, gitVisibleAtom, () => storedGit)
    await update($, nowAtom, () => Date.now())

    // Register in the background so the first prompt is not held up; tools
    // and commands await `rt.ready`.
    rt.ready = connect($, started.cwd)
    detach(
      rt.ready.then(self => {
        if (!self) return
        startWatcher($, self)
        $.clock.every(1000, () => detach(update($, nowAtom, () => Date.now())))
        $.clock.every(HEARTBEAT_MS, () => detach(rt.ready.then(current => current && beat($, current))))
      }),
    )
    if (e.isInteractive) detach($.ui.open({ id: PANE_ID, title: PANE_TITLE }))
    return started
  })

  on('session.end', async ($, e, next) => {
    rt.isStopped = true
    const self = await read($, selfAtom)
    if (self) await wsc($, ['agent', 'end', '--reason', e.reason], { cwd: self.cwd, self, timeoutMs: 5_000 })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    rt.isBusy = true
    // The first prompt may come before registration finished: wait briefly
    // for it, so the session starts with the briefing.
    const self = await Promise.race([
      rt.ready,
      new Promise<null>(resolve => void $.clock.after(5_000, () => resolve(null))),
    ])
    const note = await takePending($, self ?? (await read($, selfAtom)))
    if (!note) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e)) // never gates a prompt: on failure it passes through

  on('turn.complete', ($, e, next) => {
    rt.isBusy = false
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const self = await read($, selfAtom)
    if (!self) return composed
    const text = [
      '# Workspace Commander',
      `You are agent ${self.agentId} (session ${self.session}) in a shared multi-agent workspace for project "${self.project}".`,
      `Other agents (other Claude sessions, Antigravity, humans) coordinate through Markdown files in ${self.workspace}; the protocol is AGENT_PROTOCOL.md there.`,
      'Before significant code changes: call workspace_status; if no plan covers the work, create one with plan_create; claim a task with task_claim before working on it, and never work on a task another online agent owns.',
      'Report progress with task_update, finish with task_complete, record milestones with milestone. Ask other agents with request_create (set agent_status WAITING while you wait) and answer requests addressed to you with request_answer. New messages and answers arrive as "[Workspace Commander]" notes.',
    ].join('\n')
    return { sections: [...composed.sections, { id: `${PLUGIN}:protocol`, text, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (name.startsWith(TOOL_PREFIX)) {
      const tool = TOOLS[name.slice(TOOL_PREFIX.length)]
      if (!tool) return next(e)
      const self = await rt.ready
      if (!self) return { result: (await read($, errorAtom)) ?? 'Workspace Commander is not connected.' }
      // Workspace tool results also carry what is pending, so a session busy
      // in a long turn learns about new items without waiting for a prompt.
      const withPending = async (text: string) => {
        const note = await takePending($, self)
        return { result: note ? `${text}\n\n${note}` : text }
      }
      if (name === `${TOOL_PREFIX}workspace_status`) {
        await refreshWorkspace($, self)
        return withPending(await statusText($, self))
      }
      const result = await wsc($, tool.args(e as unknown as Record<string, unknown>), { cwd: self.cwd, self })
      scheduleRefresh($, 'workspace')
      return withPending(result.ok ? JSON.stringify(result.data, null, 2) : `Refused: ${result.error}`)
    }

    const ran = await next(e)
    const self = await read($, selfAtom)
    if (!self) return ran
    if (name === 'Bash' && ran.deny === undefined && ran.isError !== true) {
      const command = String((e as unknown as { command?: unknown }).command ?? '')
      if (/\bgit\b(\s+-\S+(\s+\S+)?)*\s+commit\b/.test(command)) {
        detach(wsc($, ['commit', 'record'], { cwd: self.cwd, self }).then(() => refreshGit($, self)))
      }
    }
    const now = Date.now()
    if (now - rt.lastHeartbeat > HEARTBEAT_MS) detach(beat($, self))
    return ran
  }).catch(($, e, next) => next(e)) // never gates a tool call: on failure it passes through

  on('command.run', { command: 'togglegit' }, async $ => {
    const isVisible = await toggleGit($)
    return { text: `Git panel: ${isVisible ? 'VISIBLE' : 'HIDDEN'}` }
  })

  on('command.run', { command: 'wc' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const self = await rt.ready
    if (arg === 'status') {
      if (!self) return { text: (await read($, errorAtom)) ?? 'Not connected.' }
      await refreshWorkspace($, self)
      return { text: '```\n' + (await statusText($, self, e.presentation.columns)) + '\n```' }
    }
    if (arg === 'refresh') {
      if (self) await Promise.all([refreshWorkspace($, self), refreshGit($, self)])
      return { text: 'Workspace refreshed.' }
    }
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: self ? `Dashboard open · ${self.agentId} · ${self.workspace}` : 'Dashboard open (connecting…)' }
  })

  on('ui.render', { component: 'Pane', requestId: 'workspace-commander' }, async ($, e) => {
    const els = $.ui.resolve(e)
    const [self, snapshot, commits, gitVisible, now, live, error] = await Promise.all([
      read($, selfAtom),
      read($, snapshotAtom),
      read($, commitsAtom),
      read($, gitVisibleAtom),
      read($, nowAtom),
      read($, liveAtom),
      read($, errorAtom),
    ])
    return renderDashboard(
      els,
      { self, snapshot, commits, gitVisible, now, live, error, columns: e.props.bodyColumns },
      () => toggleGit($),
    )
  })
}
