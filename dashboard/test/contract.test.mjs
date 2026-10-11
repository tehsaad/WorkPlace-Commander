// Contract tests: the running dashboard server against docs/DASHBOARD_API.md.
// A real server, a real vault and git repository in a temp folder, records
// written by the wsc CLI. If the API changes, this file and the doc change
// together.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const DOC = readFileSync(fileURLToPath(new URL('../../docs/DASHBOARD_API.md', import.meta.url)), 'utf8')
const SERVER = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8')

let root, repo, dashboard, port, token
const cli = (...args) => run('node', [CLI, ...args, '--json'], { cwd: repo, env: process.env }).then(r => JSON.parse(r.stdout))

function http(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}
const api = (path, opts = {}) => http(opts.body !== undefined ? 'POST' : 'GET', path, { ...opts, headers: { 'x-wc-token': token, ...(opts.headers ?? {}) } })
const action = body => api('/api/action', { body: { project: 'demo', ...body } })

/** Asserts `obj` has every key of `spec` with the given typeof ('array' for arrays, 'string?' for optional). */
function shape(obj, spec, where) {
  assert.equal(typeof obj, 'object', `${where} is an object`)
  for (const [key, type] of Object.entries(spec)) {
    const optional = type.endsWith('?')
    const want = optional ? type.slice(0, -1) : type
    const value = obj[key]
    if (optional && value === undefined) continue
    const got = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    assert.equal(got, want, `${where}.${key} should be ${type}, got ${got}`)
  }
}

const AGENT = { id: 'string', status: 'string', task: 'string', branch: 'string', session: 'string', kind: 'string', started: 'string', lastActivity: 'string', workingState: 'string', online: 'boolean' }
const TASK = { id: 'string', title: 'string', status: 'string', owner: 'string', progress: 'number?', depends: 'array', created: 'string', updated: 'string', started: 'string', completed: 'string', notes: 'string' }
const REQUEST = { id: 'string', title: 'string', status: 'string', from: 'string', to: 'string', priority: 'string', created: 'string', updated: 'string', question: 'string', answers: 'array' }
const ANSWER = { agent: 'string', timestamp: 'string', body: 'string' }
const MESSAGE = { id: 'string', from: 'string', to: 'string', timestamp: 'string', body: 'string' }
const MILESTONE = { id: 'string', title: 'string', agent: 'string', timestamp: 'string', note: 'string' }
const COMMIT_RECORD = { hash: 'string', subject: 'string', agent: 'string', timestamp: 'string', branch: 'string' }
const EVENT = { id: 'string', type: 'string', agent: 'string', session: 'string', timestamp: 'string', summary: 'string', ref: 'string?' }
const PROJECT = { slug: 'string', name: 'string', workspace: 'string', roots: 'array' }

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wsc-contract-'))
  repo = join(root, 'demo')
  mkdirSync(repo)
  Object.assign(process.env, {
    WSC_VAULT: join(root, 'vault'),
    XDG_CONFIG_HOME: join(root, 'config'),
    WSC_AGENT: '',
    WSC_SESSION: '',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'First'], { cwd: repo })
  // One record of every kind, written by the CLI (the "other side").
  await cli('agent', 'register', '--id', 'Claude-01', '--kind', 'claude-code', '--session', 's1')
  const { task } = await cli('task', 'add', 'Contract task', '--agent', 'Claude-01')
  await cli('task', 'claim', task.id, '--agent', 'Claude-01')
  await cli('msg', 'send', '--to', 'ALL', 'hello', '--agent', 'Claude-01')
  const req = await cli('request', 'create', '--to', 'Claude-01', '--title', 'Q', 'Why?', '--agent', 'Claude-01')
  await cli('request', 'answer', req.id, 'Because.', '--agent', 'Claude-01')
  await cli('milestone', 'First milestone', '--agent', 'Claude-01')
  const { createDashboard } = await import('../server.mjs')
  dashboard = createDashboard({ port: 0, host: '127.0.0.1', as: 'Human-01', cwd: repo })
  port = (await dashboard.listen()).port
  token = dashboard.token
})

after(async () => {
  await dashboard?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('contract: the document matches the server', () => {
  test('every action the server handles is documented, and nothing undocumented is handled', () => {
    const handled = [...SERVER.matchAll(/case '([a-z]+\.[a-z]+)':/g)].map(m => m[1]).sort()
    const actionSection = DOC.split('## `POST /api/action`')[1].split('\n## ')[0]
    const documented = [...actionSection.matchAll(/^\| `([a-z]+\.[a-z]+)` \|/gm)].map(m => m[1]).sort()
    assert.ok(handled.length >= 12, `expected the action switch in server.mjs, found ${handled.length}`)
    assert.deepEqual(documented, handled)
  })

  test('every endpoint the server routes is documented', () => {
    const routed = [...new Set([...SERVER.matchAll(/url\.pathname === '(\/api\/[a-z]+)'/g)].map(m => m[1]))].sort()
    for (const path of routed) assert.match(DOC, new RegExp(`## \`(GET|POST) ${path}`), `${path} is documented`)
  })
})

describe('contract: reads', () => {
  test('GET /api/projects', async () => {
    const res = await api('/api/projects')
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    shape(res.body, { projects: 'array', current: 'string' }, 'projects')
    for (const p of res.body.projects) shape(p, PROJECT, 'projects[]')
    assert.ok(res.body.projects.some(p => p.slug === res.body.current))
  })

  test('GET /api/state: top level, config and git', async () => {
    const { status, body: s } = await api('/api/state?project=demo')
    assert.equal(status, 200)
    shape(s, { project: 'object', snapshot: 'object', git: 'object', config: 'object', identity: 'string', now: 'number', serverStarted: 'number' }, 'state')
    shape(s.project, PROJECT, 'state.project')
    shape(s.config, { vault: 'string', workspace: 'string', staleAgentMinutes: 'number', protocol: 'string', configSources: 'array', registry: 'string' }, 'state.config')
    shape(s.git, { available: 'boolean', branch: 'string', commits: 'array' }, 'state.git')
    assert.equal(s.git.available, true)
    for (const c of s.git.commits) shape(c, { hash: 'string', subject: 'string', date: 'string', author: 'string', agent: 'string' }, 'git.commits[]')
    assert.equal(s.identity, 'Human-01')
  })

  test('GET /api/state: every snapshot record kind has its documented shape', async () => {
    const { snapshot } = (await api('/api/state')).body
    shape(snapshot, { project: 'string', workspace: 'string', agents: 'array', tasks: 'array', requests: 'array', messages: 'array', milestones: 'array', commits: 'array', events: 'array', plan: 'string' }, 'snapshot')
    const nonEmpty = ['agents', 'tasks', 'requests', 'messages', 'milestones', 'events']
    for (const key of nonEmpty) assert.ok(snapshot[key].length > 0, `fixture has ${key}`)
    snapshot.agents.forEach(a => shape(a, AGENT, 'agent'))
    snapshot.tasks.forEach(t => shape(t, TASK, 'task'))
    snapshot.requests.forEach(r => {
      shape(r, REQUEST, 'request')
      r.answers.forEach(a => shape(a, ANSWER, 'answer'))
    })
    assert.ok(snapshot.requests[0].answers.length === 1, 'the answer is parsed')
    snapshot.messages.forEach(m => shape(m, MESSAGE, 'message'))
    snapshot.milestones.forEach(m => shape(m, MILESTONE, 'milestone'))
    snapshot.commits.forEach(c => shape(c, COMMIT_RECORD, 'commitRecord'))
    snapshot.events.forEach(e => shape(e, EVENT, 'event'))
  })

  test('documented enums cover the values the backend writes', async () => {
    const { snapshot } = (await api('/api/state')).body
    const enumIn = heading => DOC.split(heading)[1].split('\n\n')[0]
    for (const t of snapshot.tasks) assert.ok(enumIn('**Task**').includes(`\`${t.status}\``), t.status)
    for (const a of snapshot.agents) assert.ok(enumIn('**Agent**').includes(`\`${a.status}\``), a.status)
    for (const r of snapshot.requests) assert.ok(enumIn('**Request**').includes(`\`${r.status}\``), r.status)
    for (const e of snapshot.events) assert.ok(enumIn('**WorkspaceEvent**').includes(`\`${e.type}\``), e.type)
  })

  test('an empty value (`-`) arrives as "" and an unknown progress is absent', async () => {
    const { task } = await cli('task', 'add', 'Unowned and unstarted', '--agent', 'Claude-01')
    const t = (await api('/api/state')).body.snapshot.tasks.find(x => x.id === task.id)
    assert.equal(t.owner, '')
    assert.equal(t.started, '')
    assert.ok(t.progress === undefined || typeof t.progress === 'number')
  })
})

describe('contract: GET /api/events', () => {
  test('opens with a hello event naming the project', async () => {
    const first = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/events?project=demo&token=${token}`, headers: { host: `127.0.0.1:${port}` } }, res => {
        assert.equal(res.headers['content-type'], 'text/event-stream')
        res.once('data', chunk => {
          req.destroy()
          resolve(String(chunk))
        })
      })
      req.on('error', e => (e.code === 'ECONNRESET' ? undefined : reject(e)))
      req.end()
    })
    assert.match(first, /^event: hello\ndata: \{"project":"demo"\}\n\n/)
  })
})

describe('contract: POST /api/action', () => {
  test('success is { ok: true, data } with the documented data per action', async () => {
    const added = await action({ action: 'task.add', title: 'From the contract test' })
    assert.equal(added.status, 200)
    shape(added.body, { ok: 'boolean', data: 'object' }, 'response')
    shape(added.body.data, { task: 'object', created: 'boolean' }, 'task.add')
    const id = added.body.data.task.id

    const claimed = (await action({ action: 'task.claim', id })).body.data
    shape(claimed, { task: 'object', unmetDependencies: 'array', tookOverFrom: 'string?' }, 'task.claim')
    shape((await action({ action: 'task.status', id, status: 'in_progress', progress: 50 })).body.data, TASK, 'task.status')
    shape((await action({ action: 'task.release', id })).body.data, TASK, 'task.release')
    await action({ action: 'task.claim', id })
    shape((await action({ action: 'task.complete', id })).body.data, TASK, 'task.complete')

    shape((await action({ action: 'message.send', to: 'Claude-01', body: 'hi' })).body.data, MESSAGE, 'message.send')
    const req = (await action({ action: 'request.create', to: 'Claude-01', question: 'Ok?', priority: 'high' })).body.data
    shape(req, REQUEST, 'request.create')
    assert.equal(req.priority, 'HIGH', 'enum input is case-insensitive')
    shape((await action({ action: 'request.answer', id: req.id, answer: 'Yes' })).body.data, REQUEST, 'request.answer')
    shape((await action({ action: 'request.close', id: req.id })).body.data, REQUEST, 'request.close')
    shape((await action({ action: 'milestone.add', title: 'Contract written' })).body.data, MILESTONE, 'milestone.add')
    shape((await action({ action: 'agent.status', status: 'working', state: 'testing' })).body.data, AGENT, 'agent.status')
    const plan = (await action({ action: 'plan.create', objective: 'Contract plan', tasks: ['Step one'] })).body.data
    shape(plan, { path: 'string', tasks: 'array', archived: 'string?' }, 'plan.create')
  })

  test('"as" acts as another identity, registered as a human agent', async () => {
    const res = await action({ action: 'message.send', to: 'ALL', body: 'from Design', as: 'Design-01' })
    assert.equal(res.body.data.from, 'Design-01')
    const agent = (await api('/api/state')).body.snapshot.agents.find(a => a.id === 'Design-01')
    assert.equal(agent.kind, 'human')
  })
})

describe('contract: the error envelope', () => {
  const envelope = (res, status, code) => {
    assert.equal(res.status, status)
    shape(res.body, { ok: 'boolean', error: 'string', code: 'string' }, `error ${status}`)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.code, code)
    assert.ok(res.body.error.length > 0)
  }

  test('400 invalid: unknown action, bad enum, missing field, invalid JSON', async () => {
    envelope(await action({ action: 'nope' }), 400, 'invalid')
    envelope(await action({ action: 'task.status', id: 'TASK-001', status: 'SIDEWAYS' }), 400, 'invalid')
    envelope(await action({ action: 'task.add' }), 400, 'invalid')
    envelope(await api('/api/action', { body: '{not json' }), 400, 'invalid')
  })

  test('403 invalid: no token, and a cross-origin write', async () => {
    envelope(await http('GET', '/api/state'), 403, 'invalid')
    envelope(await api('/api/action', { body: { action: 'task.add', title: 'x' }, headers: { origin: 'http://evil.example' } }), 403, 'invalid')
  })

  test('404 invalid: unknown path and unknown project', async () => {
    envelope(await api('/api/nothing'), 404, 'invalid')
    envelope(await api('/api/state?project=no-such-project'), 404, 'invalid')
  })

  test('409 refused: a task owned by an online agent; force overrides', async () => {
    const { task } = await cli('task', 'add', 'Owned by Claude', '--agent', 'Claude-01')
    await cli('task', 'claim', task.id, '--agent', 'Claude-01')
    envelope(await action({ action: 'task.claim', id: task.id }), 409, 'refused')
    envelope(await action({ action: 'task.claim', id: 'TASK-999' }), 409, 'refused')
    assert.equal((await action({ action: 'task.claim', id: task.id, force: true })).status, 200)
  })

  test('413 invalid: a body over 256 000 bytes', async () => {
    const res = await api('/api/action', { body: { action: 'message.send', to: 'ALL', body: 'x'.repeat(300_000) } }).catch(e => ({ error: e }))
    // The server may close the socket after refusing; either way nothing is written.
    if (!res.error) envelope(res, 413, 'invalid')
    const messages = (await api('/api/state')).body.snapshot.messages
    assert.ok(!messages.some(m => m.body.length > 256_000))
  })
})
