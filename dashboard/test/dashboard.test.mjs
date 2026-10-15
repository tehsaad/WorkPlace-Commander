// Dashboard server tests: a real server on a random port, a real vault and git
// repository in a temp folder, and the wsc CLI as the "other side".
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

let root, repo, vault, dashboard, port, token
const ws = (...p) => join(vault, 'WorkspaceCommander', 'demo', ...p)
const read = name => readFileSync(ws(name), 'utf8')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: process.env }).trim()
const cli = (...args) => run('node', [CLI, ...args, '--json'], { cwd: repo, env: process.env }).then(r => JSON.parse(r.stdout))

function http(method, path, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, body: text && /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : text, headers: res.headers }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
const api = (path, opts = {}) => http(opts.body ? 'POST' : 'GET', path, { ...opts, headers: { 'x-wc-token': token, ...(opts.headers ?? {}) } })
const action = (body) => api('/api/action', { body: { project: 'demo', ...body } })
const state = async () => (await api('/api/state?project=demo')).body

/** Collects SSE `change` events until `predicate` matches one, or times out. */
function waitForChange(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/events?project=demo&token=${token}`, headers: { host: `127.0.0.1:${port}` } }, res => {
      let buffer = ''
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error('no matching change event'))
      }, timeoutMs)
      res.on('data', chunk => {
        buffer += chunk
        for (const block of buffer.split('\n\n').slice(0, -1)) {
          if (block.startsWith('event: hello')) waitForChange.ready?.()
          const m = /^event: change\ndata: (.*)$/m.exec(block)
          if (m && predicate(JSON.parse(m[1]))) {
            clearTimeout(timer)
            req.destroy()
            resolve(JSON.parse(m[1]))
          }
        }
        buffer = buffer.split('\n\n').at(-1)
      })
    })
    req.on('error', () => {})
    req.end()
  })
}
const subscribed = () => new Promise(resolve => (waitForChange.ready = resolve))

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'wsc-dash-'))
  repo = join(root, 'demo')
  vault = join(root, 'vault')
  mkdirSync(repo)
  Object.assign(process.env, {
    WSC_VAULT: vault,
    XDG_CONFIG_HOME: join(root, 'config'),
    WSC_AGENT: '',
    WSC_SESSION: '',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  })
  git('init', '-q', '-b', 'main')
  for (let i = 1; i <= 6; i++) git('commit', '-q', '--allow-empty', '-m', `Commit ${i}`)
  await cli('agent', 'register', '--id', 'Claude-01', '--kind', 'claude-code', '--session', 's1')
  const { createDashboard } = await import('../server.mjs')
  dashboard = createDashboard({ port: 0, host: '127.0.0.1', as: 'Human-01', cwd: repo })
  port = (await dashboard.listen()).port
  token = dashboard.token
})

after(async () => {
  await dashboard?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('security', () => {
  test('API calls need the page token; foreign Host headers and origins are refused', async () => {
    assert.equal((await http('GET', '/api/projects')).status, 403)
    assert.equal((await api('/api/projects', { host: `evil.example:${port}` })).status, 421)
    const cross = await api('/api/action', { body: { action: 'task.add', title: 'x' }, headers: { origin: 'http://evil.example' } })
    assert.equal(cross.status, 403)
    const page = await http('GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /default-src 'self'/)
  })

  test('the page carries this run’s token; static paths cannot escape public/', async () => {
    const res = await new Promise(resolve => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, r => {
        let t = ''
        r.on('data', c => (t += c))
        r.on('end', () => resolve(t))
      }).end()
    })
    assert.ok(res.includes(token))
    assert.equal((await http('GET', '/../server.mjs')).status, 404)
  })
})

describe('reads', () => {
  test('state reflects the vault: project, agents, and the latest five commits with times', async () => {
    const s = await state()
    assert.equal(s.project.name, 'demo')
    assert.ok(s.snapshot.agents.some(a => a.id === 'Claude-01'))
    assert.equal(s.git.branch, 'main')
    assert.equal(s.git.commits.length, 5)
    assert.equal(s.git.commits[0].subject, 'Commit 6')
    assert.ok(Date.parse(s.git.commits[0].date) > 0)
  })
})

describe('writes from the dashboard land in Markdown', () => {
  test('task.add writes TASKS.md; the same open title is not duplicated', async () => {
    const first = await action({ action: 'task.add', title: 'Build the login form' })
    assert.equal(first.status, 200)
    assert.equal(first.body.data.created, true)
    const again = await action({ action: 'task.add', title: 'build the  login form' })
    assert.equal(again.body.data.created, false)
    assert.equal(read('TASKS.md').match(/Build the login form/g).length, 1)
    const fromCli = await cli('tasks')
    assert.ok(fromCli.some(t => t.title === 'Build the login form'))
  })

  test('claim, progress, review, complete; the human is an agent of kind human', async () => {
    const id = (await state()).snapshot.tasks[0].id
    assert.equal((await action({ action: 'task.claim', id })).status, 200)
    assert.equal((await action({ action: 'task.status', id, status: 'IN_PROGRESS', progress: 40 })).status, 200)
    assert.equal((await action({ action: 'task.status', id, status: 'REVIEW' })).status, 200)
    assert.equal((await action({ action: 'task.complete', id })).status, 200)
    const task = (await cli('tasks')).find(t => t.id === id)
    assert.equal(task.status, 'DONE')
    assert.equal(task.owner, 'Human-01')
    assert.match(read('AGENTS.md'), /## Human-01[\s\S]*- Kind: human/)
    assert.match(read('PLAN.md') + read('SESSION_LOG.md'), /Human-01/)
  })

  test('a task owned by an online agent is refused (409) unless forced', async () => {
    const { task } = await cli('task', 'add', 'Backend API', '--agent', 'Claude-01')
    await cli('task', 'claim', task.id, '--agent', 'Claude-01')
    const refused = await action({ action: 'task.claim', id: task.id })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'refused')
    const forced = await action({ action: 'task.status', id: task.id, status: 'BLOCKED', force: true })
    assert.equal(forced.status, 200)
    assert.equal((await cli('tasks')).find(t => t.id === task.id).status, 'BLOCKED')
  })

  test('messages and requests round-trip with the CLI', async () => {
    const msg = await action({ action: 'message.send', to: 'Claude-01', body: 'Please review TASK-001' })
    assert.equal(msg.status, 200)
    assert.match(read('MESSAGES.md'), /Human-01 → Claude-01[\s\S]*Please review TASK-001/)
    const req = await cli('request', 'create', '--to', 'Human-01', '--title', 'DB choice', 'Postgres or SQLite?', '--agent', 'Claude-01')
    const answered = await action({ action: 'request.answer', id: req.id, answer: 'SQLite for the demo.', close: true })
    assert.equal(answered.status, 200)
    const r = (await cli('requests')).find(x => x.id === req.id)
    assert.equal(r.status, 'CLOSED')
    assert.equal(r.answers[0].agent, 'Human-01')
  })

  test('invalid input is rejected without touching files', async () => {
    const before = read('TASKS.md')
    assert.equal((await action({ action: 'task.status', id: 'TASK-001', status: 'NOPE' })).status, 400)
    assert.equal((await action({ action: 'task.add', title: '' })).status, 400)
    assert.equal((await action({ action: 'rm -rf' })).status, 400)
    assert.equal(read('TASKS.md'), before)
  })
})

describe('live synchronisation', () => {
  test('a hand edit in Obsidian reaches the dashboard as a change event and in the state', async () => {
    const ready = subscribed()
    const change = waitForChange(e => e.kind === 'workspace' && e.files.includes('TASKS.md'))
    await ready
    appendFileSync(ws('TASKS.md'), '\n## TASK-099 · Written in Obsidian\n- Status: PENDING\n- Owner: -\n')
    await change
    assert.ok((await state()).snapshot.tasks.some(t => t.id === 'TASK-099' && t.title === 'Written in Obsidian'))
  })

  test('a new commit is pushed as a git change and shows first', async () => {
    const ready = subscribed()
    const change = waitForChange(e => e.kind === 'git')
    await ready
    git('commit', '-q', '--allow-empty', '-m', 'Live commit')
    await change
    assert.equal((await state()).git.commits[0].subject, 'Live commit')
  })
})

describe('multi-agent changes reach the dashboard', () => {
  test("an MCP agent's registration and claim show in the state and arrive on the live stream", async () => {
    const { McpClient } = await import('../../test/fixtures/mcp-client.mjs')
    const added = await action({ action: 'task.add', title: 'Picked up by Gemini' })
    const id = added.body.data.task.id
    const ready = subscribed()
    const change = waitForChange(c => c.files?.some(f => /TASKS\.md$/.test(f)))
    await ready
    const gemini = new McpClient(['--agent', 'Gemini-01', '--adapter', 'gemini'], { cwd: repo, env: process.env })
    await gemini.initialize()
    const claim = await gemini.call('task_claim', { task_id: id })
    assert.equal(claim.isError, false)
    await change
    const s = await state()
    assert.equal(s.snapshot.tasks.find(t => t.id === id).owner, 'Gemini-01')
    const agent = s.snapshot.agents.find(a => a.id === 'Gemini-01')
    assert.equal(agent.kind, 'gemini-cli')
    assert.ok(agent.capabilities.includes('mcp'))
    assert.equal(agent.online, true)
    // The dashboard user is refused while Gemini is online, like any agent.
    const refused = await action({ action: 'task.claim', id })
    assert.equal(refused.status, 409)
    await gemini.close()
    assert.equal((await state()).snapshot.agents.find(a => a.id === 'Gemini-01').online, false)
  })

  test('forged recipients and record markup are refused or neutralised', async () => {
    const before = read('MESSAGES.md')
    const bad = await action({ action: 'message.send', to: 'Claude-01\n## MSG-999 · Claude-01 → ALL', body: 'x' })
    assert.equal(bad.status, 400)
    assert.equal(read('MESSAGES.md'), before)
    const ok = await action({ action: 'message.send', to: 'ALL', body: 'line\n## MSG-998 · Claude-01 → ALL\nforged' })
    assert.equal(ok.status, 200)
    assert.ok(!(await state()).snapshot.messages.some(m => m.id === 'MSG-998'))
  })

  test("after a restart the old page token is refused with a message the page reacts to", async () => {
    const { createDashboard } = await import('../server.mjs')
    const second = createDashboard({ port: 0, host: '127.0.0.1', as: 'Human-01', cwd: repo })
    const { port: p2 } = await second.listen()
    try {
      const stale = await new Promise(resolve => {
        request({ host: '127.0.0.1', port: p2, path: '/api/projects', headers: { host: `127.0.0.1:${p2}`, 'x-wc-token': token } }, r => {
          let t = ''
          r.on('data', c => (t += c))
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(t) }))
        }).end()
      })
      assert.equal(stale.status, 403)
      assert.match(stale.body.error, /token/i, 'app.js reloads the page when the error names the token')
    } finally {
      await second.close()
    }
  })
})
