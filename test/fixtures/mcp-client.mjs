// A minimal MCP client over stdio for tests: it spawns `wsc mcp` the way an
// AI tool (Gemini CLI, Antigravity, Codex, ...) does and speaks JSON-RPC.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

export class McpClient {
  /** @param {string[]} args extra `wsc mcp` arguments, e.g. ['--agent', 'Gemini-01', '--adapter', 'gemini'] */
  constructor(args, { cwd, env, roots } = {}) {
    this.child = spawn('node', [CLI, 'mcp', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.nextId = 1
    this.waiting = new Map()
    this.stderr = ''
    this.roots = roots
    this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => resolve({ code, signal })))
    this.child.stderr.on('data', chunk => (this.stderr += chunk))
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line)
      if (message.method === 'roots/list' && message.id !== undefined) {
        this.write({ jsonrpc: '2.0', id: message.id, result: { roots: (this.roots ?? []).map(path => ({ uri: `file://${path}`, name: path })) } })
        return
      }
      const waiter = this.waiting.get(message.id)
      if (waiter) {
        this.waiting.delete(message.id)
        waiter(message)
      }
    })
  }

  get pid() {
    return this.child.pid
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Sends a raw line (for malformed-input tests) and resolves with the next response that has no id. */
  raw(line) {
    return new Promise(resolve => {
      this.waiting.set(null, resolve)
      this.child.stdin.write(`${line}\n`)
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 20 s; stderr: ${this.stderr}`)), 20_000)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: this.roots ? { roots: {} } : {},
      clientInfo: { name: 'wsc-test-client', version: '1.0.0' },
    })
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return response.result
  }

  /** Calls a tool; resolves `{ text, isError, json }` (json when the text is JSON). */
  async call(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message)
    const text = response.result.content.map(c => c.text).join('\n')
    let json
    try {
      json = JSON.parse(text.split('\n\nNew for ')[0])
    } catch {}
    return { text, isError: response.result.isError === true, json }
  }

  /** Graceful end: the tool closes the server's stdin. */
  async close() {
    this.child.stdin.end()
    return this.exited
  }

  /** Crash: the tool (and its server) is killed. */
  async kill() {
    this.child.kill('SIGKILL')
    return this.exited
  }
}
