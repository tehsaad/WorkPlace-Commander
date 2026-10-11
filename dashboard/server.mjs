#!/usr/bin/env node
/**
 * Workspace Commander dashboard: a local web UI over the same Obsidian vault.
 *
 * It owns no data. Every read parses the Markdown files; every write goes
 * through the same library the `wsc` CLI and the Claude Code mod use (locks,
 * atomic writes, events, duplicate-task check). Changes made in Obsidian, by
 * Claude sessions, or by other agents reach the browser through native file
 * watching (Server-Sent Events).
 *
 *   node dashboard/server.mjs [--port 4777] [--host 127.0.0.1] [--as Human-01] [--project <slug>] [--open]
 *
 * Stop it with Ctrl+C (or SIGTERM). No dependencies beyond Node 20.11+.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(HERE, '..', 'dist', 'index.js')
if (!existsSync(DIST)) {
  console.error(`Workspace Commander is not built: ${DIST} is missing. Run \`npm run build\` in ${resolve(HERE, '..')}.`)
  process.exit(1)
}
const wc = await import(DIST)

const ID_PATTERN = /^[A-Za-z][\w.-]{0,40}$/
const TASK_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'])
const AGENT_STATUSES = new Set(['IDLE', 'PLANNING', 'WORKING', 'BLOCKED', 'WAITING', 'REVIEWING', 'COMPLETED'])
const PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }

// ------------------------------------------------------------------ options

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: process.env.WC_DASHBOARD_PORT ?? '4777' },
      host: { type: 'string', default: '127.0.0.1' },
      as: { type: 'string', default: process.env.WC_DASHBOARD_AS ?? 'Human-01' },
      project: { type: 'string' },
      cwd: { type: 'string', default: process.cwd() },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (!ID_PATTERN.test(values.as)) throw new Error(`--as must look like an agent id (e.g. Human-01), got ${values.as}`)
  return { ...values, port: Number(values.port) }
}

// ------------------------------------------------------------------ projects

/**
 * Every registered project, plus the one the start directory resolves to.
 * A project's Workspace is opened from a root that still exists (for git), or
 * from its workspace folder (which always resolves back to the project).
 */
export class Projects {
  constructor(cwd) {
    this.cwd = cwd
    this.cache = new Map()
  }

  list() {
    const registry = wc.readRegistry(wc.registryPath())
    const here = wc.loadConfig(this.cwd)
    const out = new Map()
    for (const [slug, p] of Object.entries(registry.projects)) {
      const vault = here.vault
      const workspace = p.workspaceDir.startsWith('/') ? p.workspaceDir : join(vault, p.workspaceDir)
      out.set(slug, { slug, name: p.name, workspace, roots: p.roots })
    }
    const currentSlug = here.registration?.slug ?? basename(here.workspace)
    if (!out.has(currentSlug)) {
      out.set(currentSlug, { slug: currentSlug, name: here.project, workspace: here.workspace, roots: [here.projectRoot] })
    }
    return { projects: [...out.values()], current: currentSlug }
  }

  open(slug) {
    const { projects, current } = this.list()
    const project = projects.find(p => p.slug === (slug || current))
    if (!project) throw new HttpError(404, `Unknown project ${slug}`)
    const cached = this.cache.get(project.slug)
    if (cached && cached.workspace === project.workspace) return cached
    const root = project.roots.find(r => existsSync(r) && statSync(r).isDirectory())
    const ws = wc.Workspace.open(root && wc.loadConfig(root).workspace === project.workspace ? root : project.workspace)
    const gitCwd = root && wc.gitDir(root) ? root : undefined
    const entry = { ...project, ws, gitCwd, isInitialized: false }
    this.cache.set(project.slug, entry)
    return entry
  }
}

// ------------------------------------------------------------------ reads

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
}

export function gitInfo(cwd, count = 5) {
  if (!cwd) return { available: false, branch: '', commits: [] }
  let branch = ''
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {}
  let commits = []
  try {
    commits = git(cwd, ['log', '-n', String(count), '--format=%h%x1f%s%x1f%cI%x1f%an'])
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, subject, date, author] = line.split('\x1f')
        return { hash, subject, date, author }
      })
  } catch {}
  return { available: true, branch, commits }
}

function state(entry, identity) {
  const { ws } = entry
  const snapshot = ws.snapshot()
  const recorded = new Map(snapshot.commits.map(c => [c.hash.slice(0, 7), c]))
  const info = gitInfo(entry.gitCwd, ws.resolved.config.gitLogCount)
  info.commits = info.commits.map(c => ({ ...c, agent: recorded.get(c.hash.slice(0, 7))?.agent ?? '' }))
  return {
    project: { slug: entry.slug, name: entry.name, workspace: entry.workspace, roots: entry.roots },
    snapshot,
    git: info,
    config: {
      vault: ws.resolved.vault,
      workspace: ws.root,
      staleAgentMinutes: ws.resolved.config.staleAgentMinutes,
      protocol: ws.path('protocol'),
      configSources: ws.resolved.sources,
      registry: wc.registryPath(),
    },
    identity,
    now: Date.now(),
  }
}

// ------------------------------------------------------------------ writes

class HttpError extends Error {
  constructor(status, message, code = 'invalid') {
    super(message)
    this.status = status
    this.code = code
  }
}

const str = (v, what, { optional = false, max = 20_000 } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined
    throw new HttpError(400, `Missing ${what}`)
  }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `Invalid ${what}`)
  return v
}
const oneOf = (set, v, what) => {
  const value = str(v, what).toUpperCase()
  if (!set.has(value)) throw new HttpError(400, `Invalid ${what}: ${v}`)
  return value
}

/**
 * Runs one action as `identity` through the shared library. The person at the
 * dashboard is an agent of kind `human` in AGENTS.md, registered on first write.
 */
export function act(entry, identity, body) {
  const { ws } = entry
  if (!entry.isInitialized) {
    ws.init()
    entry.isInitialized = true
  }
  const id = { agent: identity, session: 'dashboard' }
  const agents = wc.listAgents(ws)
  if (!agents.some(a => a.id.toLowerCase() === identity.toLowerCase())) {
    wc.registerAgent(ws, { id: identity, kind: 'human', session: 'dashboard' })
  }
  const force = body.force === true
  switch (body.action) {
    case 'task.add':
      return wc.addTask(ws, id, str(body.title, 'title', { max: 300 }), { depends: Array.isArray(body.depends) ? body.depends.map(String) : [] })
    case 'task.claim':
      return wc.claimTask(ws, id, str(body.id, 'task id'), { force })
    case 'task.status': {
      const status = oneOf(TASK_STATUSES, body.status, 'status')
      const progress = body.progress === undefined ? undefined : Number(body.progress)
      if (progress !== undefined && !(progress >= 0 && progress <= 100)) throw new HttpError(400, 'Progress must be 0-100')
      return wc.setTaskStatus(ws, id, str(body.id, 'task id'), status, {
        force,
        ...(progress === undefined ? {} : { progress }),
        ...(body.note ? { note: str(body.note, 'note') } : {}),
      })
    }
    case 'task.complete':
      return wc.completeTask(ws, id, str(body.id, 'task id'), { force, ...(body.note ? { note: str(body.note, 'note') } : {}) })
    case 'task.release':
      return wc.releaseTask(ws, id, str(body.id, 'task id'), { force, ...(body.note ? { note: str(body.note, 'note') } : {}) })
    case 'message.send':
      return wc.sendMessage(ws, id, str(body.to, 'recipient', { max: 60 }), str(body.body, 'message'))
    case 'request.create':
      return wc.createRequest(ws, id, {
        to: str(body.to, 'recipient', { max: 60 }),
        question: str(body.question, 'question'),
        ...(body.title ? { title: str(body.title, 'title', { max: 200 }) } : {}),
        ...(body.priority ? { priority: oneOf(PRIORITIES, body.priority, 'priority') } : {}),
      })
    case 'request.answer':
      return wc.answerRequest(ws, id, str(body.id, 'request id'), str(body.answer, 'answer'), { close: body.close === true })
    case 'request.close':
      return wc.closeRequest(ws, id, str(body.id, 'request id'))
    case 'milestone.add':
      return wc.addMilestone(ws, id, str(body.title, 'title', { max: 300 }), body.note ? str(body.note, 'note') : '')
    case 'plan.create': {
      const tasks = Array.isArray(body.tasks) ? body.tasks.map(t => String(t).trim()).filter(Boolean) : []
      return wc.createPlan(ws, id, { objective: str(body.objective, 'objective'), tasks, assignments: [], dependencies: [], ...(body.notes ? { notes: String(body.notes) } : {}) })
    }
    case 'agent.status':
      return wc.setAgentStatus(ws, id, oneOf(AGENT_STATUSES, body.status, 'status'), {
        ...(body.state !== undefined ? { workingState: String(body.state) } : {}),
      })
    default:
      throw new HttpError(400, `Unknown action ${body.action}`)
  }
}

// ------------------------------------------------------------------ live updates

/** One native watcher per project, shared by every open browser tab. */
class Live {
  constructor() {
    this.channels = new Map()
  }

  subscribe(entry, res) {
    let channel = this.channels.get(entry.slug)
    if (!channel) {
      channel = { clients: new Set(), stop: () => {} }
      channel.stop = wc.watchWorkspace(entry.ws.root, entry.gitCwd ? wc.gitDir(entry.gitCwd) : undefined, event => {
        if (event.type !== 'workspace' && event.type !== 'git') return
        const line = `event: change\ndata: ${JSON.stringify({ kind: event.type, files: event.files })}\n\n`
        for (const client of channel.clients) client.write(line)
      })
      this.channels.set(entry.slug, channel)
    }
    channel.clients.add(res)
    return () => {
      channel.clients.delete(res)
      if (channel.clients.size === 0) {
        channel.stop()
        this.channels.delete(entry.slug)
      }
    }
  }

  close() {
    for (const channel of this.channels.values()) {
      channel.stop()
      for (const client of channel.clients) client.end()
    }
    this.channels.clear()
  }
}

// ------------------------------------------------------------------ server

export function createDashboard(options) {
  const token = randomBytes(18).toString('base64url')
  const projects = new Projects(options.cwd)
  const live = new Live()
  const publicDir = join(HERE, 'public')
  // Filled in once listening, from the port actually bound (--port 0 works).
  let allowedHosts = new Set()
  const started = Date.now()

  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }

  const readBody = req =>
    new Promise((resolveBody, reject) => {
      let size = 0
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > 256_000) reject(new HttpError(413, 'Request too large'))
        else chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          reject(new HttpError(400, 'Invalid JSON'))
        }
      })
      req.on('error', reject)
    })

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer to the loopback names we bound.
      if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(421, 'Unexpected Host header')
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname.startsWith('/api/')) {
        const given = req.headers['x-wc-token'] ?? url.searchParams.get('token')
        if (given !== token) throw new HttpError(403, 'Missing or wrong dashboard token (reload the page)')
        const slug = url.searchParams.get('project') ?? undefined
        if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, projects.list())
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const entry = projects.open(slug)
          return send(res, 200, { ...state(entry, options.as), serverStarted: started })
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const entry = projects.open(slug)
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          res.write(`event: hello\ndata: ${JSON.stringify({ project: entry.slug })}\n\n`)
          const unsubscribe = live.subscribe(entry, res)
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
          req.on('close', () => {
            clearInterval(ping)
            unsubscribe()
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
          const origin = req.headers.origin
          if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'Cross-origin request refused')
          const body = await readBody(req)
          const identity = body.as && ID_PATTERN.test(body.as) ? body.as : options.as
          const entry = projects.open(body.project ?? slug)
          try {
            return send(res, 200, { ok: true, data: act(entry, identity, body) })
          } catch (error) {
            if (error instanceof HttpError) throw error
            if (error?.name === 'CoordinationError' || wc.CoordinationError && error instanceof wc.CoordinationError) {
              throw new HttpError(409, error.message, 'refused')
            }
            throw error
          }
        }
        throw new HttpError(404, 'Not found')
      }
      // Static files; the page gets this run's token.
      const file = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '')
      const path = join(publicDir, file)
      if (!path.startsWith(publicDir) || !existsSync(path) || !statSync(path).isFile()) throw new HttpError(404, 'Not found')
      let content = readFileSync(path)
      if (file === 'index.html') content = Buffer.from(content.toString('utf8').replace('__WC_TOKEN__', token))
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      })
      res.end(content)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) console.error(error)
      send(res, status, { ok: false, error: error.message, code: error instanceof HttpError ? error.code : 'error' })
    }
  })

  return {
    server,
    token,
    listen: () =>
      new Promise(resolveListen =>
        server.listen(options.port, options.host, () => {
          const { port } = server.address()
          allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${options.host}:${port}`])
          resolveListen(server.address())
        }),
      ),
    close: () =>
      new Promise(resolveClose => {
        live.close()
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      }),
  }
}

// ------------------------------------------------------------------ main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(64)
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 14).map(l => l.replace(/^ \*\s?/, '')).join('\n'))
    process.exit(0)
  }
  const dashboard = createDashboard(options)
  dashboard.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${options.port} is in use. Pass --port <n>.` : error.message)
    process.exit(1)
  })
  const { port } = await dashboard.listen()
  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${port}/${options.project ? `#project=${encodeURIComponent(options.project)}` : ''}`
  console.log(`Workspace Commander dashboard: ${url}`)
  console.log(`Acting as ${options.as} · vault data via ${wc.registryPath()} · Ctrl+C to stop`)
  if (options.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  }
  const stop = async () => {
    await dashboard.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
