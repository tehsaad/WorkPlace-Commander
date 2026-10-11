/**
 * Runs under `claude plugin test .`: the mod loaded by the engine's own host,
 * with this file's `on` hooks standing in for the host beneath it (process,
 * fs, session). No real files or processes are touched.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const WS = '/vault/WorkspaceCommander'
const FILES = {
  projectNotes: 'ProjectNotes.md',
  agents: 'AGENTS.md',
  plan: 'PLAN.md',
  tasks: 'TASKS.md',
  messages: 'MESSAGES.md',
  requests: 'REQUESTS.md',
  milestones: 'MILESTONES.md',
  commits: 'COMMITS.md',
  sessionLog: 'SESSION_LOG.md',
  sessionsDir: 'SESSIONS',
  protocol: 'AGENT_PROTOCOL.md',
}

// Written the way a human or an external AI would, not by our renderer.
const FIXTURES: Record<string, string> = {
  [`${WS}/AGENTS.md`]: `# Agents

## Claude-01
- Status: WORKING
- Task: TASK-002 Implement backend
- Session: sess_test
- Last Activity: 2099-01-01T00:00:00+00:00
- Online: yes

## Antigravity-01
Status: WAITING
Task: TASK-003 Implement frontend
Online: yes
`,
  [`${WS}/TASKS.md`]: `# Tasks

## TASK-001 · Inspect existing authentication
- Status: DONE
- Owner: Claude-01

## TASK-002 · Implement backend
- Status: in progress
- Owner: Claude-01
- Progress: 68%
- Started: 2026-10-08T19:00:00+05:00

## TASK-003 · Implement frontend
- **Status:** BLOCKED
- **Owner:** Antigravity-01

## TASK-004 · Write integration tests
- Status: TODO
- Owner: -
`,
  [`${WS}/REQUESTS.md`]: `# Requests

## REQUEST-001 · Token storage
- Status: OPEN
- From: Antigravity-01
- To: Claude-01
- Priority: HIGH

### Question

Should refresh tokens be stored in Redis or PostgreSQL?
`,
  [`${WS}/SESSION_LOG.md`]: `# Session Log

<!-- WC_EVENT
id: evt_a
type: TASK_COMPLETED
agent: Claude-01
session: sess_test
timestamp: 2026-10-08T19:31:00+05:00
ref: TASK-001
-->
- 19:31 **Claude-01** completed TASK-001 Inspect existing authentication
`,
  [`${WS}/MILESTONES.md`]: `## MILESTONE-001 · API schema agreed
- Agent: Antigravity-01
- Time: 2026-10-08T19:20:00+05:00
`,
}

const COMMIT = 'a82f12d'

/** Stands in for the host beneath the plugin. Returns the argv of every process run. */
function host(on: On, options: { heartbeatSession?: string } = {}) {
  const runs: string[][] = []
  mock.store(on)
  mock.env(on, {})
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__workspace-commander__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', async ($, e) => {
    const text = FIXTURES[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const argv = e.argv.join(' ')
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.includes('agent register')) {
      return ok(
        JSON.stringify({
          agent: { id: 'Claude-01', session: 'sess_test' },
          resumed: false,
          workspace: WS,
          project: 'my-project',
          files: FILES,
          config: { staleAgentMinutes: 30, gitLogCount: 5, autoWake: true },
        }),
      )
    }
    if (argv.includes('agent heartbeat')) {
      return ok(JSON.stringify({ id: 'Claude-01', session: options.heartbeatSession ?? 'sess_test', online: true, reaped: [] }))
    }
    if (argv.startsWith('git log')) return ok(`${COMMIT} Implement authentication\n91ac332 Add API validation\n`)
    if (argv.includes('task claim TASK-003')) {
      return ok(JSON.stringify({ error: 'TASK-003 is owned by Antigravity-01 (WAITING).', code: 2 }), 2)
    }
    return ok('{}')
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"ready","workspace":"/vault/WorkspaceCommander","gitDir":null,"recursive":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  return { runs, clock }
}

/** A slash command as the person types it. */
function typed(command: string, args = '') {
  return { command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
}

const PANE = {
  plugin: 'workspace-commander',
  component: 'Pane' as const,
  requestId: 'workspace-commander',
  props: {
    title: 'Workspace Commander',
    isFocused: false,
    bodyColumns: 96,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}

describe('workspace-commander', () => {
  test('registers the agent with its session and kind', async ($, on) => {
    const { runs } = host(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh')) // waits for registration
    const register = runs.find(argv => argv.includes('register'))
    expect(register).toBeDefined()
    expect(register!.join(' ')).toContain('agent register --kind claude-code --session sess_test')
    expect(register!.at(-1)).toBe('--json')
  })

  test('the dashboard shows counters, agents, work, requests, activity, milestones and git', async ($, on) => {
    host(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: 'WORKSPACE COMMANDER' })).toBeDefined()
      expect(await ui.find({ text: 'my-project' })).toBeDefined()
      expect(await ui.find({ text: /^\d\d:\d\d:\d\d$/ })).toBeDefined() // session timer
      // 1 done, 1 ongoing (in progress), 1 pending (TODO), 1 blocked
      const counts = (await ui.findAll({ type: 'Text', text: /^\d+$/ })).map(t => t.text)
      expect(counts.slice(0, 4)).toEqual(['1', '1', '1', '1'])
      expect(await ui.find({ text: /Implement backend/ })).toBeDefined()
      expect(await ui.find({ text: /68%/ })).toBeDefined()
      expect(await ui.find({ text: /Antigravity-01/ })).toBeDefined()
      expect(await ui.find({ text: /WAITING/ })).toBeDefined()
      expect(await ui.find({ text: /REQUEST-001/ })).toBeDefined()
      expect(await ui.find({ text: /completed TASK-001/ })).toBeDefined()
      expect(await ui.find({ text: /API schema agreed/ })).toBeDefined()
      expect(await ui.find({ text: COMMIT })).toBeDefined()
      await ui.unmount()
    }
  })

  test('/togglegit and the dashboard button control the same Git panel state', async ($, on) => {
    host(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'toggle-git', text: 'Hide Git' })).toBeDefined()
      expect(await ui.find({ text: COMMIT })).toBeDefined()

      await ui.press({ key: 'toggle-git' }) // the button hides it
      expect(await ui.find({ text: COMMIT })).toBeUndefined()
      expect(await ui.find({ key: 'toggle-git', text: 'Show Git' })).toBeDefined()

      const shown = await $.command.run(typed('togglegit', '')) // the command shows it again
      expect(shown.text).toBe('Git panel: VISIBLE')
      expect(await ui.find({ text: COMMIT })).toBeDefined()
      expect(await ui.find({ key: 'toggle-git', text: 'Hide Git' })).toBeDefined()

      const hidden = await $.command.run(typed('togglegit', ''))
      expect(hidden.text).toBe('Git panel: HIDDEN')
      expect(await ui.find({ text: COMMIT })).toBeUndefined()
      await $.command.run(typed('togglegit', '')) // leave it visible
      await ui.unmount()
    }
  })

  test('tools write through wsc with this agent identity and report refusals', async ($, on) => {
    const { runs } = host(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    const claimed = await $.tool.call({ tool: 'mcp__workspace-commander__task_claim', task_id: 'TASK-004' })
    expect(claimed.isError).toBeUndefined()
    const argv = runs.find(a => a.includes('claim'))!.join(' ')
    expect(argv).toContain('task claim TASK-004 --agent Claude-01 --session sess_test --json')

    const refused = await $.tool.call({ tool: 'mcp__workspace-commander__task_claim', task_id: 'TASK-003' })
    expect(String(refused.result)).toContain('Refused: TASK-003 is owned by Antigravity-01')

    const status = await $.tool.call({ tool: 'mcp__workspace-commander__workspace_status' })
    expect(String(status.result)).toContain('Open requests for you: REQUEST-001 from Antigravity-01')
  })

  test('a git commit run through Bash is recorded', async ($, on) => {
    const { runs } = host(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '[main a82f12d] Implement authentication', stderr: '', interrupted: false } }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "Implement authentication"' })
    await $.command.run(typed('wc', 'refresh'))
    expect(runs.some(a => a.join(' ').includes('commit record --agent Claude-01'))).toBe(true)
  })

  test('the system prompt names the agent and the workspace', async ($, on) => {
    host(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
    const mine = sections.find(s => s.id === 'workspace-commander:protocol')
    expect(mine?.text).toContain('You are agent Claude-01')
    expect(mine?.text).toContain(WS)
  })

  test('an idle session heartbeats on a timer, so it is never marked offline', async ($, on) => {
    const { runs, clock } = host(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    const beats = () => runs.filter(a => a.join(' ').includes('agent heartbeat --agent Claude-01 --session sess_test')).length
    expect(beats()).toBe(0)
    await clock.advance(120_000)
    expect(beats()).toBe(1)
    await clock.advance(240_000)
    expect(beats()).toBe(3)
  })

  test('a session whose id was taken over while suspended registers again', async ($, on) => {
    const { runs, clock } = host(on, { heartbeatSession: 'someone_else' })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.command.run(typed('wc', 'refresh'))
    const registrations = () => runs.filter(a => a.join(' ').includes('agent register')).length
    expect(registrations()).toBe(1)
    await clock.advance(120_000)
    await $.command.run(typed('wc', 'refresh'))
    expect(registrations()).toBe(2)
  })

  test('the first prompt carries a startup briefing of the shared state, once', async ($, on) => {
    host(on)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      contexts.push(e.context)
      return { text: e.text, ...(e.context ? { context: e.context } : {}) }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
    const briefing = (contexts[0] ?? []).join('\n')
    expect(briefing).toContain('Session briefing for Claude-01')
    expect(briefing).toContain('Antigravity-01')
    expect(briefing).toContain('TASK-004 PENDING · unowned: Write integration tests')
    expect(briefing).toContain('REQUEST-001 from Antigravity-01 (HIGH)')
    await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
    expect(contexts[1] ?? []).toHaveLength(0)
  })
})
