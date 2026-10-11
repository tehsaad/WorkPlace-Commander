// Integration tests for the wsc CLI and the Markdown protocol, run with real
// processes and real files: `npm test`.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  buildDashboard,
  formatElapsed,
  parseAgents,
  parseEvents,
  parseRequests,
  parseTasks,
  setFields,
} from '../dist/index.js'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

let root
let repo
let vault
let env

function ws(...parts) {
  return join(vault, 'WorkspaceCommander', 'my-project', ...parts)
}

function read(name) {
  return readFileSync(ws(name), 'utf8')
}

async function wsc(args, options = {}) {
  try {
    const { stdout } = await run('node', [CLI, ...args, '--json'], { cwd: repo, env: { ...env, ...options.env } })
    return { code: 0, data: JSON.parse(stdout) }
  } catch (error) {
    return { code: error.code, data: error.stdout ? JSON.parse(error.stdout) : undefined, stderr: error.stderr }
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim()
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'wsc-test-'))
  repo = join(root, 'my-project')
  vault = join(root, 'vault')
  mkdirSync(repo)
  env = {
    ...process.env,
    WSC_VAULT: vault,
    XDG_CONFIG_HOME: join(root, 'config'), // isolate from the user's real config
    WSC_AGENT: '',
    WSC_SESSION: '',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'Initial commit')
})

after(() => rmSync(root, { recursive: true, force: true }))

describe('workspace setup', () => {
  test('init creates the Obsidian structure without overwriting', async () => {
    const first = await wsc(['init'])
    assert.equal(first.code, 0)
    for (const file of ['ProjectNotes.md', 'AGENTS.md', 'PLAN.md', 'TASKS.md', 'MESSAGES.md', 'REQUESTS.md', 'MILESTONES.md', 'COMMITS.md', 'SESSION_LOG.md', 'AGENT_PROTOCOL.md']) {
      assert.ok(read(file).length > 0, `${file} exists`)
    }
    appendFileSync(ws('ProjectNotes.md'), '\nHuman note: keep me.\n')
    const second = await wsc(['init'])
    assert.deepEqual(second.data.created, [])
    assert.match(read('ProjectNotes.md'), /Human note: keep me\./)
  })

  test('config resolves the vault path and the project notes name', async () => {
    const { data } = await wsc(['config'])
    assert.equal(data.vault, vault)
    assert.equal(data.workspace, ws())
    assert.equal(data.project, 'my-project')
    assert.equal(data.config.projectNotes, 'ProjectNotes.md')
  })

  test('a project config file overrides the workspace folder', async () => {
    writeFileSync(join(repo, '.workspace-commander.json'), JSON.stringify({ workspaceDir: 'Elsewhere', projectNotes: 'Notes.md' }))
    const { data } = await wsc(['config'])
    assert.equal(data.workspace, join(vault, 'Elsewhere'))
    assert.equal(data.config.projectNotes, 'Notes.md')
    rmSync(join(repo, '.workspace-commander.json'))
    rmSync(join(vault, 'Elsewhere'), { recursive: true, force: true })
  })
})

describe('two simultaneous agent sessions', () => {
  test('concurrent registration hands out distinct ids', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => wsc(['agent', 'register', '--prefix', 'Claude', '--kind', 'claude-code', '--session', `sess_${i}`])),
    )
    const ids = results.map(r => r.data.agent.id).sort()
    assert.deepEqual(ids, ['Claude-01', 'Claude-02', 'Claude-03', 'Claude-04', 'Claude-05', 'Claude-06'])
    const agents = parseAgents(read('AGENTS.md'))
    assert.equal(agents.length, 6)
  })

  test('re-registering the same session resumes its id (restart recovery)', async () => {
    const again = await wsc(['agent', 'register', '--prefix', 'Claude', '--session', 'sess_3'])
    const before = parseAgents(read('AGENTS.md')).find(a => a.session === 'sess_3')
    assert.equal(again.data.resumed, true)
    assert.equal(again.data.agent.id, before.id)
  })

  test('a new session reuses the id of an agent whose session ended', async () => {
    const ended = parseAgents(read('AGENTS.md')).find(a => a.session === 'sess_5')
    await wsc(['agent', 'end', '--agent', ended.id, '--session', 'sess_5'])
    const fresh = await wsc(['agent', 'register', '--prefix', 'Claude', '--session', 'sess_new'])
    assert.equal(fresh.data.agent.id, ended.id)
    assert.equal(fresh.data.resumed, false)
  })

  test('an external agent registers by explicit id', async () => {
    const r = await wsc(['agent', 'register', '--id', 'Antigravity-01', '--kind', 'antigravity', '--session', 'ag_1'])
    assert.equal(r.data.agent.id, 'Antigravity-01')
  })

  test('stale agents are marked offline in AGENTS.md; fresh, unparseable and own records are kept', async () => {
    const section = (id, lastActivity) =>
      `\n## ${id}\n- Status: WORKING\n- Task: -\n- Session: s_${id}\n- Kind: antigravity\n- Last Activity: ${lastActivity}\n- Working State: busy\n- Online: yes\n\nHand-written note kept.\n`
    appendFileSync(ws('AGENTS.md'), section('Ghost-01', '2020-01-01T00:00:00+00:00'))
    appendFileSync(ws('AGENTS.md'), section('Fresh-01', new Date().toISOString()))
    appendFileSync(ws('AGENTS.md'), section('Odd-01', 'sometime yesterday'))

    const beat = await wsc(['agent', 'heartbeat', '--agent', 'Antigravity-01', '--session', 'ag_1'])
    assert.equal(beat.code, 0)
    assert.deepEqual(beat.data.reaped, ['Ghost-01'])
    const byId = id => parseAgents(read('AGENTS.md')).find(a => a.id === id)
    assert.equal(byId('Ghost-01').online, false)
    assert.equal(byId('Ghost-01').status, 'WORKING') // only Online and Working State change
    assert.equal(byId('Ghost-01').lastActivity, '2020-01-01T00:00:00+00:00')
    assert.equal(byId('Fresh-01').online, true)
    assert.equal(byId('Odd-01').online, true)
    assert.equal(byId('Antigravity-01').online, true)
    assert.match(read('AGENTS.md'), /## Ghost-01[\s\S]*Hand-written note kept\./)
    assert.ok(parseEvents(read('SESSION_LOG.md')).some(e => e.ref === 'Ghost-01' && /marked Ghost-01 offline/.test(e.summary)))

    // Nothing left to reap; the ghost coming back flips itself online again.
    assert.deepEqual((await wsc(['agent', 'reap'])).data.reaped, [])
    await wsc(['agent', 'heartbeat', '--agent', 'Ghost-01', '--session', 's_Ghost-01'])
    assert.equal(byId('Ghost-01').online, true)
  })

  test('a stale record is reaped by the next registration', async () => {
    const before = read('AGENTS.md')
    writeFileSync(ws('AGENTS.md'), before.replace(/(## Ghost-01[\s\S]*?- Last Activity: )\S+/, '$12020-01-01T00:00:00+00:00'))
    const r = await wsc(['agent', 'register', '--id', 'Late-01', '--session', 'late_1'])
    assert.deepEqual(r.data.reaped, ['Ghost-01'])
  })
})

describe('planning and task ownership', () => {
  const A = ['--agent', 'Claude-01', '--session', 'sess_0']
  const B = ['--agent', 'Antigravity-01', '--session', 'ag_1']

  test('plan create writes PLAN.md and the tasks', async () => {
    const r = await wsc(['plan', 'create', ...A, '--objective', 'Implement user authentication.', '--task', 'Inspect existing authentication', '--task', 'Implement backend', '--task', 'Implement frontend', '--assign', 'Claude-01=Backend', '--assign', 'Antigravity-01=Frontend', '--dep', 'Frontend depends on backend API contract.'])
    assert.equal(r.code, 0)
    assert.deepEqual(r.data.tasks.map(t => t.id), ['TASK-001', 'TASK-002', 'TASK-003'])
    const plan = read('PLAN.md')
    assert.match(plan, /## Objective\n\nImplement user authentication\./)
    assert.match(plan, /- \[ \] TASK-002 Implement backend/)
    assert.match(plan, /- Antigravity-01 → Frontend/)
  })

  test('adding a task with an existing open title returns the existing task', async () => {
    const r = await wsc(['task', 'add', ...B, 'implement BACKEND'])
    assert.equal(r.data.created, false)
    assert.equal(r.data.task.id, 'TASK-002')
  })

  test('ten agents racing to claim one task: exactly one wins', async () => {
    const racers = Array.from({ length: 10 }, (_, i) => `Racer-${String(i).padStart(2, '0')}`)
    for (const id of racers) await wsc(['agent', 'register', '--id', id, '--session', `race_${id}`])
    const results = await Promise.all(racers.map(id => wsc(['task', 'claim', 'TASK-001', '--agent', id, '--session', `race_${id}`])))
    const winners = results.filter(r => r.code === 0)
    assert.equal(winners.length, 1)
    assert.ok(results.filter(r => r.code !== 0).every(r => r.code === 2 && /owned by/.test(r.data.error)))
    const owner = parseTasks(read('TASKS.md')).find(t => t.id === 'TASK-001').owner
    assert.equal(owner, winners[0].data.task.owner)
    // hand it back for the rest of the suite
    await wsc(['task', 'release', 'TASK-001', '--agent', owner, '--session', `race_${owner}`])
    for (const id of racers) await wsc(['agent', 'end', '--agent', id, '--session', `race_${id}`])
  })

  test('claim, progress, and refusal of another online agent', async () => {
    const claim = await wsc(['task', 'claim', 'TASK-002', ...A])
    assert.equal(claim.code, 0)
    const steal = await wsc(['task', 'claim', 'TASK-002', ...B])
    assert.equal(steal.code, 2)
    assert.match(steal.data.error, /owned by Claude-01/)
    await wsc(['task', 'status', 'TASK-002', 'IN_PROGRESS', '--progress', '68', ...A])
    const task = parseTasks(read('TASKS.md')).find(t => t.id === 'TASK-002')
    assert.equal(task.status, 'IN_PROGRESS')
    assert.equal(task.progress, 68)
    const agent = parseAgents(read('AGENTS.md')).find(a => a.id === 'Claude-01')
    assert.equal(agent.status, 'WORKING')
    assert.match(agent.task, /TASK-002/)
  })

  test('dependencies produce a warning, not a refusal', async () => {
    writeFileSync(ws('TASKS.md'), read('TASKS.md').replace('## TASK-003 · Implement frontend\n', '## TASK-003 · Implement frontend\n- Depends: TASK-002\n'))
    const r = await wsc(['task', 'claim', 'TASK-003', ...B])
    assert.equal(r.code, 0)
    assert.deepEqual(r.data.unmetDependencies, ['TASK-002'])
  })

  test('completion ticks the plan and frees the agent', async () => {
    const r = await wsc(['task', 'done', 'TASK-002', ...A, '--note', 'API ready'])
    assert.equal(r.data.status, 'DONE')
    assert.match(read('PLAN.md'), /- \[x\] TASK-002 Implement backend/)
    assert.match(read('TASKS.md'), /> Completed by Claude-01: API ready/)
    assert.equal(parseAgents(read('AGENTS.md')).find(a => a.id === 'Claude-01').status, 'COMPLETED')
  })

  test('a task owned by an offline agent can be taken over', async () => {
    await wsc(['agent', 'end', ...B])
    const r = await wsc(['task', 'claim', 'TASK-003', ...A])
    assert.equal(r.code, 0)
    assert.equal(r.data.tookOverFrom, 'Antigravity-01')
    await wsc(['agent', 'register', '--id', 'Antigravity-01', '--session', 'ag_1'])
    await wsc(['task', 'release', 'TASK-003', ...A])
  })
})

describe('messages and requests', () => {
  const A = ['--agent', 'Claude-01', '--session', 'sess_0']
  const B = ['--agent', 'Antigravity-01', '--session', 'ag_1']

  test('twenty concurrent messages get twenty unique ids and an intact file', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => wsc(['msg', 'send', ...(i % 2 ? A : B), '--to', i % 2 ? 'Antigravity-01' : 'Claude-01', `message number ${i}`])))
    const { data } = await wsc(['msg', 'list'])
    assert.equal(data.length, 20)
    assert.equal(new Set(data.map(m => m.id)).size, 20)
    for (let i = 0; i < 20; i++) assert.ok(data.some(m => m.body === `message number ${i}`), `message ${i} kept`)
    const inbox = await wsc(['msg', 'inbox', ...A])
    assert.equal(inbox.data.length, 10)
    assert.ok(inbox.data.every(m => m.to === 'Claude-01'))
  })

  test('request, answer, close', async () => {
    const created = await wsc(['request', 'create', ...A, '--to', 'Antigravity-01', '--priority', 'HIGH', '--title', 'Token storage', 'Should refresh tokens be stored in Redis or PostgreSQL?'])
    assert.equal(created.data.id, 'REQUEST-001')
    assert.equal(created.data.status, 'OPEN')
    const answered = await wsc(['request', 'answer', 'REQUEST-001', 'Redis, with a TTL.', ...B])
    assert.equal(answered.data.status, 'ANSWERED')
    assert.equal(answered.data.answers[0].agent, 'Antigravity-01')
    const closed = await wsc(['request', 'close', 'REQUEST-001', ...A])
    assert.equal(closed.data.status, 'CLOSED')
  })
})

describe('Markdown interoperability (an AI without Workspace Commander)', () => {
  test('a hand-written request answer is understood', async () => {
    await wsc(['request', 'create', '--agent', 'Claude-01', '--to', 'Antigravity-01', '--title', 'Review the database migration', 'Review the database migration and identify possible problems.'])
    // Antigravity edits REQUESTS.md directly, as AGENT_PROTOCOL.md describes.
    const text = read('REQUESTS.md')
      .replace(/(## REQUEST-002[\s\S]*?- Status: )OPEN/, '$1ANSWERED')
      .trimEnd()
    writeFileSync(ws('REQUESTS.md'), `${text}\n\n### Answer — Antigravity-01 · 2026-10-08 19:50\n\nFindings:\n1. Migration is missing an index.\n2. Rollback does not restore the dropped column.\n`)
    const request = parseRequests(read('REQUESTS.md')).find(r => r.id === 'REQUEST-002')
    assert.equal(request.status, 'ANSWERED')
    assert.equal(request.answers.length, 1)
    assert.equal(request.answers[0].agent, 'Antigravity-01')
    assert.match(request.answers[0].body, /missing an index/)
    // The earlier request's own answers are untouched by the hand edit.
    assert.equal(parseRequests(read('REQUESTS.md')).find(r => r.id === 'REQUEST-001').answers.length, 1)
  })

  test('a hand-written task in loose formatting can be claimed and keeps its notes', async () => {
    appendFileSync(ws('TASKS.md'), '\n## TASK-010: Write integration tests\nStatus: todo\n**Owner:** -\n\nCover the login flow end to end.\n')
    const r = await wsc(['task', 'claim', 'TASK-010', '--agent', 'Claude-02', '--session', 'sess_1'])
    assert.equal(r.code, 0)
    const task = parseTasks(read('TASKS.md')).find(t => t.id === 'TASK-010')
    assert.equal(task.owner, 'Claude-02')
    assert.equal(task.status, 'IN_PROGRESS')
    assert.equal(task.notes, 'Cover the login flow end to end.')
  })

  test('hand-written messages without event blocks are read', async () => {
    appendFileSync(ws('MESSAGES.md'), '\n## MSG-021 · Antigravity-01 → Claude-01\nFROM: Antigravity-01\nTO: Claude-01\n\nFrontend is wired to the new API.\n')
    const { data } = await wsc(['msg', 'inbox', '--agent', 'Claude-01', '--after', 'MSG-020'])
    assert.equal(data.length, 1)
    assert.equal(data[0].body, 'Frontend is wired to the new API.')
  })

  test('every write is mirrored as a parseable WC_EVENT with unique ids', () => {
    const events = parseEvents(read('SESSION_LOG.md'))
    assert.ok(events.length > 50)
    assert.equal(new Set(events.map(e => e.id)).size, events.length)
    for (const type of ['AGENT_REGISTERED', 'PLAN_CREATED', 'TASK_CLAIMED', 'TASK_COMPLETED', 'MESSAGE_SENT', 'REQUEST_CREATED', 'REQUEST_ANSWERED', 'SESSION_ENDED']) {
      assert.ok(events.some(e => e.type === type), `has ${type}`)
    }
    assert.ok(events.every(e => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(e.timestamp)))
  })

  test('ProjectNotes status block is regenerated and human text kept', async () => {
    await wsc(['milestone', 'Backend auth complete', '--agent', 'Claude-01'])
    const notes = read('ProjectNotes.md')
    assert.match(notes, /Human note: keep me\./)
    assert.match(notes, /\*\*Last milestone:\*\* Backend auth complete \(Claude-01\)/)
    assert.equal(notes.match(/wc:status:start/g).length, 1)
  })
})

describe('git', () => {
  test('git log matches git log --oneline -n 5', async () => {
    for (let i = 1; i <= 6; i++) git('commit', '-q', '--allow-empty', '-m', `Change ${i}`)
    const { data } = await wsc(['git'])
    assert.equal(data.length, 5)
    assert.equal(data.map(c => `${c.hash} ${c.subject}`).join('\n'), git('log', '--oneline', '-n', '5'))
  })

  test('commit record is idempotent; commit sync records only commits after its baseline', async () => {
    const first = await wsc(['commit', 'record', '--agent', 'Claude-01'])
    assert.equal(first.data.subject, 'Change 6')
    const again = await wsc(['commit', 'record', '--agent', 'Claude-02'])
    assert.equal(again.data, null)
    const baseline = await wsc(['commit', 'sync'])
    assert.deepEqual(baseline.data, []) // first sync only sets the baseline
    git('commit', '-q', '--allow-empty', '-m', 'Human commit')
    const synced = await wsc(['commit', 'sync'])
    assert.equal(synced.data.length, 1)
    assert.equal(synced.data[0].agent, 'external')
    assert.match(read('COMMITS.md'), /Human commit · external · main/)
  })
})

describe('file watching', () => {
  test('wsc watch reports workspace edits and new commits', async () => {
    const child = spawn('node', [CLI, 'watch'], { cwd: repo, env })
    const events = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line))
    })
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (events.some(predicate)) return true
        await new Promise(r => setTimeout(r, 50))
      }
      return false
    }
    try {
      assert.ok(await waitFor(e => e.type === 'ready'), 'ready')
      appendFileSync(ws('MESSAGES.md'), '\n## MSG-099 · Human → ALL\nFROM: Human\nTO: ALL\n\nhello\n')
      assert.ok(await waitFor(e => e.type === 'workspace' && e.files.includes('MESSAGES.md')), 'workspace change seen')
      git('commit', '-q', '--allow-empty', '-m', 'Watched commit')
      assert.ok(await waitFor(e => e.type === 'git'), 'git change seen')
    } finally {
      child.kill('SIGTERM')
    }
  })
})

describe('locking and recovery', () => {
  test('an abandoned lock is taken over after it goes stale', async () => {
    const lock = ws('.wc', 'locks', 'TASKS.md.lock')
    writeFileSync(lock, JSON.stringify({ token: 'crashed-agent', at: '2026-01-01' }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const started = Date.now()
    const r = await wsc(['task', 'add', '--agent', 'Claude-01', 'Survive a crashed agent'])
    assert.equal(r.code, 0)
    assert.ok(Date.now() - started < 5_000)
  })

  test('no temp files or locks are left behind', () => {
    const leftovers = execFileSync('find', [ws(), '-name', '*.tmp', '-o', '-name', '*.lock'], { encoding: 'utf8' }).trim()
    assert.equal(leftovers, '')
  })
})

describe('dashboard model', () => {
  test('counters, timer, and current work', () => {
    const snapshot = JSON.parse(execFileSync('node', [CLI, 'snapshot', '--json'], { cwd: repo, env, encoding: 'utf8' }))
    const model = buildDashboard(snapshot, { now: Date.now(), self: 'Claude-01', staleMinutes: 30 })
    const tasks = parseTasks(read('TASKS.md'))
    assert.equal(model.counts.completed, tasks.filter(t => t.status === 'DONE').length)
    assert.equal(model.counts.ongoing, tasks.filter(t => t.status === 'IN_PROGRESS' || t.status === 'REVIEW').length)
    assert.equal(model.counts.pending, tasks.filter(t => t.status === 'PENDING').length)
    assert.equal(model.counts.total, tasks.length)
    assert.ok(model.work.every(w => w.status !== 'DONE'))
    assert.equal(model.work[0].status, 'IN_PROGRESS') // ongoing work first
    assert.equal(formatElapsed(6_138_000), '01:42:18')
  })

  test('wsc status renders the text dashboard', async () => {
    const { stdout } = await run('node', [CLI, 'status', '--agent', 'Claude-01', '--width', '80'], { cwd: repo, env })
    assert.match(stdout, /WORKSPACE COMMANDER/)
    assert.match(stdout, /CURRENT WORK/)
    assert.match(stdout, /Human commit/)
    assert.ok(stdout.split('\n').every(line => line.length <= 80))
  })

  test('setFields edits in place and keeps unknown lines', () => {
    const raw = '## TASK-001 · X\n- Status: PENDING\n- Custom: keep\n\nNotes stay.\n'
    const out = setFields(raw, [
      { label: 'Status', value: 'DONE' },
      { label: 'Owner', value: 'Claude-01' },
    ])
    assert.equal(out, '## TASK-001 · X\n- Status: DONE\n- Custom: keep\n- Owner: Claude-01\n\nNotes stay.\n')
  })
})

describe('projects: persistent registry and isolation', () => {
  const projectsFile = () => join(root, 'config', 'workspace-commander', 'projects.json')
  const wscIn = (cwd, args) =>
    run('node', [CLI, ...args, '--json'], { cwd, env }).then(r => JSON.parse(r.stdout))

  test('a second repository gets its own folder; its tasks never appear in the first', async () => {
    const other = join(root, 'other-app')
    mkdirSync(other)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other })
    await wscIn(other, ['task', 'add', 'Only in other-app', '--agent', 'Claude-09'])
    const mine = await wscIn(repo, ['tasks'])
    const theirs = await wscIn(other, ['tasks'])
    assert.ok(theirs.some(t => t.title === 'Only in other-app'))
    assert.ok(!mine.some(t => t.title === 'Only in other-app'))
    const registry = JSON.parse(readFileSync(projectsFile(), 'utf8'))
    assert.equal(registry.projects['other-app'].workspaceDir, 'WorkspaceCommander/other-app')
    assert.deepEqual(registry.projects['my-project'].roots, [repo])
  })

  test('a git worktree and a joined repository share the project', async () => {
    execFileSync('git', ['worktree', 'add', '-q', join(root, 'wt'), '-b', 'wt-branch'], { cwd: repo, env })
    const fromWorktree = await wscIn(join(root, 'wt'), ['project'])
    assert.equal(fromWorktree.workspace, ws())
    const extra = join(root, 'docs-site')
    mkdirSync(extra)
    const joined = await wscIn(extra, ['project', 'register', '--name', 'my-project'])
    assert.equal(joined.slug, 'my-project')
    assert.equal((await wscIn(extra, ['project'])).workspace, ws())
  })

  test('read-only commands do not register; PROJECTS.md lists projects and keeps human text', async () => {
    const scratch = join(root, 'scratch')
    mkdirSync(scratch)
    const shown = await wscIn(scratch, ['project'])
    assert.equal(shown.registered, false)
    assert.ok(!JSON.parse(readFileSync(projectsFile(), 'utf8')).projects.scratch)
    const index = join(vault, 'WorkspaceCommander', 'PROJECTS.md')
    appendFileSync(index, '\nHuman note about projects.\n')
    await wscIn(scratch, ['init'])
    const text = readFileSync(index, 'utf8')
    assert.match(text, /\[\[scratch\/ProjectNotes\\\|scratch\]\]/)
    assert.match(text, /\[\[my-project\/ProjectNotes\\\|my-project\]\]/)
    assert.match(text, /Human note about projects\./)
  })

  test('an invalid projects.json is reported, never replaced', async () => {
    const good = readFileSync(projectsFile(), 'utf8')
    writeFileSync(projectsFile(), '{ broken')
    const result = await wsc(['tasks'])
    assert.notEqual(result.code, 0)
    assert.equal(readFileSync(projectsFile(), 'utf8'), '{ broken')
    writeFileSync(projectsFile(), good)
  })

  test('agent-setup --write keeps the rest of the file, backs it up, and is idempotent', async () => {
    const rules = join(root, 'GEMINI.md')
    writeFileSync(rules, '# My rules\n\nAlways be kind.\n')
    await wsc(['agent-setup', 'antigravity', '--id', 'Antigravity-01', '--write', rules])
    await wsc(['agent-setup', 'antigravity', '--id', 'Antigravity-01', '--write', rules])
    const text = readFileSync(rules, 'utf8')
    assert.match(text, /Always be kind\./)
    assert.equal(text.match(/wc:agent-setup:start/g).length, 1)
    assert.match(text, /Antigravity-01/)
    assert.match(text, /PROJECTS\.md/)
    const backups = execFileSync('ls', [root], { encoding: 'utf8' }).split('\n').filter(f => f.startsWith('GEMINI.md.bak-'))
    assert.ok(backups.length >= 1)
  })
})
