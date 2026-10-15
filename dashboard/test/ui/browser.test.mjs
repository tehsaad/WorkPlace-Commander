// Browser tests for the dashboard: headless Chrome driven over the DevTools
// protocol (no dependencies), against a real server, vault and git repository
// in a temp folder. `npm run test:ui`. Skipped when no Chrome is found
// (set CHROME=/path/to/chrome to choose one).
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { McpClient } from '../../../test/fixtures/mcp-client.mjs'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  p => p && existsSync(p),
)

let root, repo, chrome, cdp, dashboard, port
const cli = (...args) => run('node', [CLI, ...args, '--json'], { cwd: repo, env: process.env }).then(r => JSON.parse(r.stdout))
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A minimal DevTools protocol client over the browser's WebSocket. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.waiting = new Map()
    this.events = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.id && this.waiting.has(message.id)) {
        const { resolve, reject } = this.waiting.get(message.id)
        this.waiting.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : resolve(message.result)
      } else if (message.method) this.events.push(message)
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }
}

/** One tab: evaluate expressions, press keys, wait for conditions. */
class Page {
  constructor(session) {
    this.session = session
  }
  async eval(expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.session)
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  async waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression)
        if (last) return last
      } catch (error) {
        last = error.message // the page may be reloading
      }
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${expression} (last: ${last})`)
  }
  async key(key) {
    const codes = { Tab: 9, Enter: 13, Escape: 27 }
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 }, this.session)
    }
  }
  async viewport(width, height, mobile = false) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, this.session)
  }
  async goto(url) {
    await cdp.send('Page.navigate', { url }, this.session)
    await this.waitFor(`document.readyState === 'complete' && !!document.querySelector('.main')`)
  }
  errors() {
    return cdp.events
      .filter(e => e.sessionId === this.session && (e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')))
      .map(e => e.params.exceptionDetails?.exception?.description ?? e.params.args?.map(a => a.value ?? a.description).join(' '))
  }
}

async function openPage() {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  return new Page(sessionId)
}

async function startDashboard(onPort = 0) {
  const { createDashboard } = await import('../../server.mjs')
  const d = createDashboard({ port: onPort, host: '127.0.0.1', as: 'Human-01', cwd: repo })
  const address = await d.listen()
  return { d, port: address.port }
}

describe('dashboard in a real browser', { skip: CHROME ? false : 'no Chrome or Chromium found (set CHROME)' }, () => {
  let page

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'wsc-ui-'))
    repo = join(root, 'ui-demo')
    mkdirSync(repo)
    Object.assign(process.env, { WSC_VAULT: join(root, 'vault'), XDG_CONFIG_HOME: join(root, 'config'), WSC_AGENT: '', WSC_SESSION: '' })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    await cli('agent', 'register', '--id', 'Claude-01', '--kind', 'claude-code', '--session', 'ui')
    await cli('plan', 'create', '--agent', 'Claude-01', '--objective', 'UI test', '--task', 'First task', '--task', 'Second task')
    ;({ d: dashboard, port } = await startDashboard())

    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chrome')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const url = await new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${text}`)), 20_000)
      chrome.stderr.on('data', chunk => {
        text += chunk
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(text)
        if (m) {
          clearTimeout(timer)
          resolve(m[1])
        }
      })
    })
    cdp = new Cdp(url)
    await cdp.ready
    page = await openPage()
    await page.viewport(1366, 900)
  })

  after(async () => {
    try {
      cdp?.ws.close()
    } catch {}
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve))
      chrome.kill('SIGKILL')
      await exited
    }
    await dashboard?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('the board loads without script errors; landmarks, skip link and accessible names', async () => {
    await page.goto(`http://127.0.0.1:${port}/#view=tasks`)
    await page.waitFor(`document.querySelectorAll('[data-task]').length === 2`)
    assert.equal(await page.eval(`document.documentElement.lang`), 'en')
    assert.equal(await page.eval(`document.querySelectorAll('main').length`), 1)
    assert.equal(await page.eval(`document.querySelector('a, button, input, select, [tabindex="0"]').className`), 'skip-link')
    const unnamed = await page.eval(`[...document.querySelectorAll('button, select, input')].filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() || el.title || el.labels?.length)).map(el => el.outerHTML.slice(0, 80))`)
    assert.deepEqual(unnamed, [], 'every control has an accessible name')
    assert.deepEqual(page.errors(), [])
  })

  test('a card opens its details; Escape closes them and returns focus to the card', async () => {
    await page.eval(`document.querySelector('[data-task="TASK-001"] .card-title').click()`)
    await page.waitFor(`document.querySelector('#drawer-root [role=dialog]')?.textContent.includes('First task')`)
    assert.equal(await page.eval(`document.activeElement.classList.contains('drawer')`), true)
    assert.match(await page.eval(`document.querySelector('.drawer').textContent`), /History[\s\S]*Claude-01/)
    await page.key('Escape')
    await page.waitFor(`!document.querySelector('#drawer-root [role=dialog]')`)
    assert.equal(await page.eval(`document.activeElement?.dataset?.task`), 'TASK-001')
  })

  test('Enter opens details from the keyboard and Tab stays inside the drawer', async () => {
    await page.eval(`document.querySelector('[data-task="TASK-002"]').focus()`)
    await page.key('Enter')
    await page.waitFor(`document.querySelector('#drawer-root [role=dialog]')?.textContent.includes('Second task')`)
    for (let i = 0; i < 12; i++) {
      await page.key('Tab')
      assert.equal(await page.eval(`document.querySelector('#drawer-root').contains(document.activeElement)`), true, `focus left the drawer after ${i + 1} Tabs`)
    }
  })

  test('the open drawer follows a claim made by another agent', async () => {
    await cli('task', 'claim', 'TASK-002', '--agent', 'Claude-01', '--session', 'ui')
    await page.waitFor(`/in progress/i.test(document.querySelector('.drawer .pill')?.textContent ?? '') && document.querySelector('.drawer').textContent.includes('claude-code')`)
    await page.key('Escape')
  })

  test('agents registered through MCP show their kind and capabilities', async () => {
    const gemini = new McpClient(['--agent', 'Gemini-01', '--adapter', 'gemini'], { cwd: repo, env: process.env })
    await gemini.initialize()
    await gemini.call('workspace_status')
    await page.eval(`location.hash = 'view=agents&project=ui-demo'; dispatchEvent(new HashChangeEvent('hashchange'))`)
    await page.eval(`document.querySelector('[data-go="agents"]').click()`)
    await page.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes('Gemini-01') && r.textContent.includes('gemini-cli') && r.querySelector('.tag')?.textContent)`)
    await gemini.close()
  })

  test('phone width: no horizontal page scroll, the drawer fills the screen', async () => {
    await page.viewport(390, 844, true)
    for (const view of ['overview', 'tasks', 'agents', 'messages']) {
      await page.eval(`document.querySelector('[data-go="${view}"]').click()`)
      await sleep(150)
      const overflow = await page.eval(`document.scrollingElement.scrollWidth - innerWidth`)
      assert.ok(overflow <= 1, `${view} scrolls sideways by ${overflow}px`)
    }
    await page.eval(`document.querySelector('[data-go="tasks"]').click()`)
    await page.waitFor(`document.querySelector('[data-task="TASK-001"]')`)
    await page.eval(`document.querySelector('[data-task="TASK-001"] .card-title').click()`)
    await page.waitFor(`document.querySelector('.drawer')`)
    assert.equal(await page.eval(`Math.round(document.querySelector('.drawer').getBoundingClientRect().width)`), 390)
    await page.key('Escape')
    await page.viewport(1366, 900)
  })

  test('server down: a banner says so; server back with a new token: the page recovers by itself', async () => {
    const before = await page.eval(`document.querySelector('meta[name=wc-token]').content`)
    await dashboard.close()
    await page.waitFor(`!!document.querySelector('.banner')`, 15_000)
    ;({ d: dashboard } = await startDashboard(port))
    await page.waitFor(`document.querySelector('meta[name=wc-token]')?.content !== ${JSON.stringify(before)} && !document.querySelector('.banner') && document.querySelectorAll('.nav-item').length > 0`, 30_000)
    await cli('task', 'add', 'Added after the restart', '--agent', 'Claude-01')
    await page.eval(`document.querySelector('[data-go="tasks"]').click()`)
    await page.waitFor(`document.body.textContent.includes('Added after the restart')`)
  })
})
