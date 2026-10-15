// Workspace Commander dashboard client. No framework: state in, HTML out,
// event delegation for behaviour. Every write is an /api/action call that the
// server runs through the shared Markdown library; every change on disk comes
// back through Server-Sent Events.

const TOKEN = document.querySelector('meta[name="wc-token"]').content
const $root = document.getElementById('app')

const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'messages', label: 'Messages', icon: 'messages' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'milestones', label: 'Plan & Milestones', icon: 'milestones' },
  { id: 'git', label: 'Git history', icon: 'git' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]
const COLUMNS = [
  { status: 'PENDING', label: 'Pending' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'REVIEW', label: 'In Review' },
  { status: 'DONE', label: 'Completed' },
  { status: 'BLOCKED', label: 'Blocked' },
]
const STATUS_COLOR = { PENDING: 'var(--pending)', IN_PROGRESS: 'var(--progress)', REVIEW: 'var(--review)', DONE: 'var(--done)', BLOCKED: 'var(--blocked)' }
const AGENT_STATUSES = ['IDLE', 'PLANNING', 'WORKING', 'BLOCKED', 'WAITING', 'REVIEWING', 'COMPLETED']
const EVENT_GROUPS = {
  tasks: ['TASK_CREATED', 'TASK_CLAIMED', 'TASK_RELEASED', 'TASK_STATUS', 'TASK_COMPLETED', 'PLAN_CREATED'],
  comms: ['MESSAGE_SENT', 'REQUEST_CREATED', 'REQUEST_ANSWERED', 'REQUEST_CLOSED'],
  agents: ['AGENT_REGISTERED', 'AGENT_STATUS', 'SESSION_STARTED', 'SESSION_ENDED'],
  progress: ['MILESTONE_REACHED', 'COMMIT_CREATED', 'NOTE_ADDED'],
}

// ------------------------------------------------------------------ prefs

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`wc:${key}`)
      return v === null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`wc:${key}`, JSON.stringify(value))
    } catch {}
  },
}

// ------------------------------------------------------------------ state

const S = {
  projects: [],
  project: null,
  data: null,
  view: 'overview',
  connection: 'connecting',
  error: '',
  collapsed: prefs.get('collapsed', false),
  navOpen: false,
  gitVisible: prefs.get('gitVisible', true),
  compact: prefs.get('compact', false),
  as: prefs.get('as', ''),
  board: { q: '', owner: '' },
  comms: { tab: 'messages', filter: 'all', selected: null, reqFilter: 'open' },
  activity: { group: 'all', agent: '' },
  seenEvents: new Set(),
  flash: new Set(),
  /** Task shown in the detail drawer, and the element to refocus when it closes. */
  detail: null,
  detailReturn: null,
  loadedAt: 0,
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`
const me = () => S.as || S.data?.identity || 'Human-01'
const isMe = id => String(id || '').toLowerCase() === me().toLowerCase()

// ------------------------------------------------------------------ time

const parseTime = s => {
  const t = Date.parse(s || '')
  return Number.isNaN(t) ? undefined : t
}
function duration(ms) {
  if (ms === undefined || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m`
  return `${s}s`
}
function clock(ms) {
  if (ms === undefined) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
function ago(s) {
  const t = parseTime(s)
  if (t === undefined) return '—'
  const d = Date.now() - t
  if (d < 45_000) return 'just now'
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}
const fullTime = s => {
  const t = parseTime(s)
  return t === undefined ? '' : new Date(t).toLocaleString()
}
const hhmm = s => {
  const t = parseTime(s)
  return t === undefined ? '' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ------------------------------------------------------------------ derived

function online(agent) {
  if (!agent.online) return false
  const last = parseTime(agent.lastActivity)
  return last === undefined || Date.now() - last < (S.data?.config.staleAgentMinutes ?? 30) * 60_000
}
const agents = () => S.data?.snapshot.agents ?? []
const tasks = () => S.data?.snapshot.tasks ?? []
const onlineAgents = () => agents().filter(online)
function counts() {
  const c = { PENDING: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0, BLOCKED: 0 }
  for (const t of tasks()) c[t.status] = (c[t.status] ?? 0) + 1
  return c
}
/** The shared session: from the earliest start among agents online now. */
function sessionStart() {
  const starts = onlineAgents().map(a => parseTime(a.started)).filter(t => t !== undefined)
  return starts.length ? Math.min(...starts) : undefined
}
function taskDuration(t) {
  const start = parseTime(t.started)
  if (start === undefined) return undefined
  const end = t.status === 'DONE' ? parseTime(t.completed) ?? parseTime(t.updated) : Date.now()
  return end === undefined ? undefined : end - start
}
function openRequestsFor(id) {
  return (S.data?.snapshot.requests ?? []).filter(r => r.status === 'OPEN' && (r.to.toLowerCase() === id.toLowerCase() || r.to.toUpperCase() === 'ALL') && r.from.toLowerCase() !== id.toLowerCase())
}

const AV_COLORS = ['#8a95ff', '#4cb782', '#e0a95f', '#c58af9', '#5bb4d6', '#e57f7f', '#9fc56a', '#d68fb8']
function avatar(id, lg = false) {
  if (!id || id === '-') return `<span class="avatar empty-av${lg ? ' lg' : ''}" title="Unassigned">–</span>`
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const parts = id.split(/[-_ ]/)
  const initials = (parts[0][0] + (parts[1]?.replace(/^0+/, '')[0] ?? parts[0][1] ?? '')).toUpperCase()
  return `<span class="avatar${lg ? ' lg' : ''}" style="background:${AV_COLORS[h % AV_COLORS.length]}" title="${esc(id)}">${esc(initials)}</span>`
}
const pill = (status, label = status.replace('_', ' ').toLowerCase()) => `<span class="pill s-${esc(status)}">${esc(label)}</span>`

// ------------------------------------------------------------------ api

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'x-wc-token': TOKEN, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (res.status === 403 && /token/i.test(body.error ?? '')) reloadForNewToken()
  if (!res.ok) {
    const error = new Error(body.error || `HTTP ${res.status}`)
    error.code = body.code
    error.status = res.status
    throw error
  }
  return body
}

/** Runs an action; on a protocol refusal offers a forced retry where that makes sense. */
async function act(action, args = {}, { success, forceable = false } = {}) {
  try {
    const result = await api('/api/action', { method: 'POST', body: JSON.stringify({ action, project: S.project, as: S.as || undefined, ...args }) })
    if (success) toast(typeof success === 'function' ? success(result.data) : success, 'ok')
    await refresh()
    return result.data
  } catch (error) {
    if (error.code === 'refused' && forceable && !args.force) {
      toast(error.message, 'error', [{ label: 'Override', run: () => act(action, { ...args, force: true }, { success }) }])
    } else {
      toast(error.message, 'error')
    }
    return undefined
  }
}

/**
 * The server hands each page a per-run token. After the server restarts, the
 * open page's token is refused: reload once to get the new one (at most every
 * 15 s, so a misconfigured server cannot cause a reload loop).
 */
function reloadForNewToken() {
  let last = 0
  try {
    last = Number(sessionStorage.getItem('wc:reloadAt') || 0)
  } catch {}
  if (Date.now() - last < 15_000) return
  try {
    sessionStorage.setItem('wc:reloadAt', String(Date.now()))
  } catch {}
  location.reload()
}

/** Announces a change to screen readers without moving focus. */
function announce(text) {
  const el = document.getElementById('sr-live')
  if (!el || !text) return
  el.textContent = ''
  setTimeout(() => (el.textContent = text), 30)
}

let refreshTimer
let refreshing = false
async function refresh() {
  if (!S.project) return
  if (refreshing) {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 120)
    return
  }
  refreshing = true
  try {
    const previous = S.data
    S.data = await api(`/api/state?project=${encodeURIComponent(S.project)}`)
    S.error = ''
    S.loadedAt = Date.now()
    if (previous) {
      const before = new Map(previous.snapshot.tasks.map(t => [t.id, `${t.status}|${t.owner}|${t.progress}|${t.title}`]))
      const changed = []
      for (const t of S.data.snapshot.tasks) {
        if (before.get(t.id) !== `${t.status}|${t.owner}|${t.progress}|${t.title}`) {
          S.flash.add(t.id)
          changed.push(`${t.id} ${t.status.replace('_', ' ').toLowerCase()}${t.owner ? `, ${t.owner}` : ''}`)
        }
      }
      if (changed.length) announce(`Updated: ${changed.slice(0, 3).join('; ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`)
    }
    render()
    S.flash.clear()
  } catch (error) {
    S.error = error.message
    render()
  } finally {
    refreshing = false
  }
}

let source
let retry = 1000
function connectLive() {
  source?.close()
  S.connection = 'connecting'
  renderTopbar()
  source = new EventSource(`/api/events?project=${encodeURIComponent(S.project)}&token=${encodeURIComponent(TOKEN)}`)
  source.addEventListener('hello', () => {
    S.connection = 'live'
    retry = 1000
    renderTopbar()
    refresh()
  })
  source.addEventListener('change', () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 120)
  })
  source.onerror = () => {
    S.connection = 'offline'
    render()
    source.close()
    // EventSource hides the status: ask once whether the token is the problem.
    api('/api/projects').catch(() => {})
    setTimeout(connectLive, retry)
    retry = Math.min(retry * 2, 15_000)
  }
}

// ------------------------------------------------------------------ routing

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  const view = params.get('view')
  if (view && VIEWS.some(v => v.id === view)) S.view = view
  return params.get('project')
}
function writeHash() {
  const params = new URLSearchParams({ view: S.view, project: S.project ?? '' })
  history.replaceState(null, '', `#${params}`)
}
function go(view) {
  S.view = view
  S.navOpen = false
  writeHash()
  render()
  document.querySelector('.content')?.scrollTo(0, 0)
}
async function switchProject(slug) {
  if (!slug || slug === S.project) return
  S.project = slug
  S.data = null
  S.comms.selected = null
  prefs.set('project', slug)
  writeHash()
  render()
  connectLive()
}

// ------------------------------------------------------------------ render: shell

function render() {
  document.documentElement.classList.toggle('compact', S.compact)
  // Keep half-typed drafts and focus across live re-renders.
  const drafts = {}
  document.querySelectorAll('[data-draft]').forEach(el => (drafts[el.dataset.draft] = el.value))
  const focused = document.activeElement?.dataset?.draft
  const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null
  const scroll = {}
  document.querySelectorAll('[data-scroll]').forEach(el => (scroll[el.dataset.scroll] = el.scrollTop))

  $root.className = `app${S.collapsed ? ' collapsed' : ''}${S.navOpen ? ' nav-open' : ''}`
  $root.innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a>${sidebar()}<div class="scrim" data-act="close-nav"></div><main class="main" id="main-content" tabindex="-1"><header class="topbar" id="topbar">${topbar()}</header>${banner()}${content()}</main>`
  renderDrawer()

  document.querySelectorAll('[data-draft]').forEach(el => {
    if (drafts[el.dataset.draft] !== undefined) el.value = drafts[el.dataset.draft]
  })
  if (focused) {
    const el = document.querySelector(`[data-draft="${focused}"]`)
    if (el) {
      el.focus()
      if (selection && el.setSelectionRange) el.setSelectionRange(...selection)
    }
  }
  document.querySelectorAll('[data-scroll]').forEach(el => {
    if (scroll[el.dataset.scroll] !== undefined) el.scrollTop = scroll[el.dataset.scroll]
  })
  for (const e of S.data?.snapshot.events ?? []) S.seenEvents.add(e.id)
}

function renderTopbar() {
  const bar = document.getElementById('topbar')
  if (bar) bar.innerHTML = topbar()
}

function sidebar() {
  const c = counts()
  const badges = {
    agents: onlineAgents().length,
    tasks: c.PENDING + c.IN_PROGRESS + c.REVIEW + c.BLOCKED,
    messages: openRequestsFor(me()).length || '',
  }
  const item = v => `<button class="nav-item${S.view === v.id ? ' active' : ''}" data-go="${v.id}" title="${esc(v.label)}" aria-current="${S.view === v.id ? 'page' : 'false'}">${icon(v.icon)}<span>${esc(v.label)}</span>${badges[v.id] ? `<span class="count">${badges[v.id]}</span>` : ''}</button>`
  return `<aside class="sidebar" aria-label="Navigation">
    <div class="brand"><div class="brand-mark">WC</div><div class="brand-name">Workspace Commander</div></div>
    <nav class="nav">
      <div class="nav-label">Workspace</div>
      ${VIEWS.slice(0, 4).map(item).join('')}
      <div class="nav-label">Coordination</div>
      ${VIEWS.slice(4, 8).map(item).join('')}
    </nav>
    <div class="sidebar-foot">
      ${item(VIEWS[8])}
      <div class="identity" title="Writes are made as this agent">${avatar(me())}<span class="label">${esc(me())}</span></div>
      <button class="nav-item hide-sm" data-act="collapse" title="${S.collapsed ? 'Expand' : 'Collapse'} sidebar">${icon('panel')}<span>Collapse</span></button>
    </div>
  </aside>`
}

function topbar() {
  const view = VIEWS.find(v => v.id === S.view)
  const branch = S.data?.git.branch
  const conn = { live: ['live', 'Live'], connecting: ['connecting', 'Connecting'], offline: ['offline', 'Reconnecting'] }[S.connection]
  return `
    <button class="btn ghost icon-only menu-toggle" data-act="open-nav" aria-label="Menu">${icon('menu')}</button>
    <div class="crumbs">
      <select class="project-select" data-change="project" aria-label="Project">
        ${S.projects.map(p => `<option value="${esc(p.slug)}"${p.slug === S.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <span class="crumb-sep hide-sm">/</span><span class="view-title hide-sm">${esc(view?.label ?? '')}</span>
    </div>
    ${branch ? `<span class="chip hide-md" title="Current Git branch">${icon('branch')}${esc(branch)}</span>` : ''}
    <span class="chip" title="Workspace connection: file watching over Server-Sent Events"><span class="dot ${conn[0]}"></span><span class="hide-sm">${conn[1]}</span></span>
    <span class="chip hide-sm" title="Agents online">${icon('agents')}${onlineAgents().length} active</span>
    <div class="topbar-spacer"></div>
    <button class="search-btn" data-act="palette" aria-label="Search and commands">${icon('search')}<span class="label">Search or run a command</span><span class="kbd">⌘K</span></button>
    <button class="btn ghost icon-only" data-go="settings" aria-label="Settings" title="Settings">${icon('settings')}</button>`
}

function content() {
  if (S.error && !S.data) {
    return `<div class="content"><div class="panel" role="alert"><div class="empty">${icon('help')}Could not load the workspace: ${esc(S.error)}<div style="margin-top:12px"><button class="btn" data-act="retry">Try again</button></div></div></div></div>`
  }
  if (!S.data) return `<div class="content"><div class="loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Loading the workspace…</div></div>`
  switch (S.view) {
    case 'projects': return `<div class="content">${viewProjects()}</div>`
    case 'agents': return `<div class="content">${viewAgents()}</div>`
    case 'tasks': return `<div class="content flush">${viewTasks()}</div>`
    case 'messages': return `<div class="content flush">${viewComms()}</div>`
    case 'activity': return `<div class="content" data-scroll="activity">${viewActivity()}</div>`
    case 'milestones': return `<div class="content">${viewMilestones()}</div>`
    case 'git': return `<div class="content">${viewGit()}</div>`
    case 'settings': return `<div class="content">${viewSettings()}</div>`
    default: return `<div class="content">${viewOverview()}</div>`
  }
}

/** Shown above the view while the data on screen may be out of date. */
function banner() {
  if (!S.data) return ''
  const at = S.loadedAt ? new Date(S.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  if (S.error) {
    return `<div class="banner error" role="alert">${icon('help')}<span class="grow">Lost contact with the dashboard server (${esc(S.error)}). Showing the workspace as of ${esc(at)}; retrying.</span><button class="btn sm" data-act="retry">Retry now</button></div>`
  }
  if (S.connection === 'offline') {
    return `<div class="banner warn" role="status">${icon('clock')}<span class="grow">Live updates paused, reconnecting. Changes made elsewhere appear once the connection is back.</span><button class="btn sm" data-act="retry">Reload data</button></div>`
  }
  return ''
}

const head = (title, sub, actions = '') => `<div class="section-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`
const empty = (text, ic = 'inbox') => `<div class="empty">${icon(ic)}${esc(text)}</div>`

// ------------------------------------------------------------------ overview

function viewOverview() {
  const c = counts()
  const total = tasks().length
  const on = onlineAgents()
  const start = sessionStart()
  const working = on.filter(a => a.status === 'WORKING').length
  const metric = (label, value, sub, color) => `<div class="metric"><div class="metric-label">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}</div><div class="metric-value"${label === 'Session time' ? ' data-tick="session"' : ''}>${value}</div><div class="metric-sub">${sub}</div></div>`
  const pct = n => (total ? Math.round((n / total) * 100) : 0)

  const events = S.data.snapshot.events
  const hours = Array.from({ length: 24 }, () => 0)
  const now = Date.now()
  for (const e of events) {
    const t = parseTime(e.timestamp)
    if (t === undefined || now - t > 24 * 3_600_000) continue
    hours[23 - Math.floor((now - t) / 3_600_000)]++
  }
  const peak = Math.max(1, ...hours)
  const requests = S.data.snapshot.requests.filter(r => r.status === 'OPEN')

  return `${head(S.data.project.name, `Workspace <span class="mono">${esc(S.data.config.workspace)}</span>`, `<button class="btn" data-act="new-task">${icon('plus')}New task</button>`)}
  <div class="metrics">
    ${metric('Session time', clock(start === undefined ? undefined : now - start), start ? `since ${new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, earliest online agent` : 'no agent online')}
    ${metric('Completed', c.DONE, `${pct(c.DONE)}% of ${total} tasks`, STATUS_COLOR.DONE)}
    ${metric('Ongoing', c.IN_PROGRESS + c.REVIEW, `${c.REVIEW} in review`, STATUS_COLOR.IN_PROGRESS)}
    ${metric('Pending', c.PENDING, `${tasks().filter(t => t.status === 'PENDING' && !t.owner).length} unassigned`, STATUS_COLOR.PENDING)}
    ${metric('Blocked', c.BLOCKED, c.BLOCKED ? 'needs attention' : 'nothing blocked', STATUS_COLOR.BLOCKED)}
    ${metric('Active agents', on.length, `${working} working · ${agents().length} known`)}
  </div>
  <div class="grid-2">
    <div class="stack">
      <section class="panel"><div class="panel-head"><span class="panel-title">Task distribution</span><button class="btn ghost sm" data-go="tasks">Open board</button></div>
        <div class="panel-body">
          <div class="dist" role="img" aria-label="Tasks by status">${COLUMNS.map(col => (c[col.status] ? `<i style="width:${(c[col.status] / Math.max(total, 1)) * 100}%;background:${STATUS_COLOR[col.status]}" title="${col.label}: ${c[col.status]}"></i>` : '')).join('')}</div>
          <div class="legend">${COLUMNS.map(col => `<div class="legend-item"><div class="row"><span class="dot" style="background:${STATUS_COLOR[col.status]}"></span>${col.label}</div><b>${c[col.status]}</b></div>`).join('')}</div>
          <div class="spark" title="Workspace events per hour, last 24 hours">${hours.map((n, i) => `<i style="height:${Math.max(3, (n / peak) * 100)}%" title="${n} events, ${23 - i}h ago"></i>`).join('')}</div>
          <div class="spark-axis"><span>24h ago</span><span>Activity per hour</span><span>now</span></div>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><span class="panel-title">Current work</span><button class="btn ghost sm" data-go="tasks">All tasks</button></div>
        <div class="panel-body tight"><div class="list">${(() => {
          const active = tasks().filter(t => t.status === 'IN_PROGRESS' || t.status === 'REVIEW' || t.status === 'BLOCKED')
          return active.length
            ? active.map(t => `<div class="list-row clickable" data-open-task="${esc(t.id)}"><span class="mono faint nowrap">${esc(t.id)}</span><span class="grow truncate">${esc(t.title)}</span>${t.progress !== undefined ? `<div class="bar hide-sm" style="width:64px"><i style="width:${t.progress}%"></i></div>` : ''}${pill(t.status)}${avatar(t.owner)}</div>`).join('')
            : empty('No task in progress. Claim one on the board.', 'tasks')
        })()}</div></div>
      </section>
      <section class="panel"><div class="panel-head"><span class="panel-title">Recent activity</span><button class="btn ghost sm" data-go="activity">View all</button></div>
        <div class="panel-body tight"><div class="list">${events.slice(-7).reverse().map(e => `<div class="list-row"><span class="mono faint nowrap">${hhmm(e.timestamp)}</span><span class="grow truncate"><b>${esc(e.agent)}</b> <span class="muted">${esc(e.summary)}</span></span></div>`).join('') || empty('No events yet.', 'activity')}</div></div>
      </section>
    </div>
    <div class="stack">
      <section class="panel"><div class="panel-head"><span class="panel-title">Agents</span><button class="btn ghost sm" data-go="agents">Monitor</button></div>
        <div class="panel-body tight"><div class="list">${agents().length ? [...agents()].sort((a, b) => online(b) - online(a)).slice(0, 8).map(a => `<div class="list-row">${avatar(a.id)}<div class="grow"><div class="truncate"><b>${esc(a.id)}</b> <span class="faint">${esc(a.kind)}</span></div><div class="truncate faint" style="font-size:12px">${esc(a.task || a.workingState || '—')}</div></div>${online(a) ? pill(a.status) : '<span class="pill no-dot">offline</span>'}</div>`).join('') : empty('No agent has registered yet.', 'agents')}</div></div>
      </section>
      <section class="panel"><div class="panel-head"><span class="panel-title">Open requests</span><button class="btn ghost sm" data-act="comms-requests">Requests</button></div>
        <div class="panel-body tight"><div class="list">${requests.length ? requests.slice(0, 6).map(r => `<div class="list-row clickable" data-open-request="${esc(r.id)}"><span class="mono faint">${esc(r.id)}</span><span class="grow truncate">${esc(r.title)}</span><span class="faint nowrap hide-sm">${esc(r.from)} → ${esc(r.to)}</span>${pill(r.priority)}</div>`).join('') : empty('No open requests.', 'messages')}</div></div>
      </section>
      ${S.gitVisible ? `<section class="panel"><div class="panel-head"><span class="panel-title">Latest commits</span><button class="btn ghost sm" data-act="toggle-git">${icon('eye-off')}Hide</button></div><div class="panel-body tight"><div class="list">${commitRows(5)}</div></div></section>` : ''}
    </div>
  </div>`
}

function commitRows(n) {
  const git = S.data.git
  if (!git.available) return empty('This project has no Git repository on this machine.', 'git')
  if (!git.commits.length) return empty('No commits yet.', 'git')
  return git.commits.slice(0, n).map(c => `<div class="list-row"><span class="commit-hash">${esc(c.hash)}</span><span class="grow truncate">${esc(c.subject)}</span><span class="faint nowrap" title="${esc(fullTime(c.date))}">${ago(c.date)}</span></div>`).join('')
}

// ------------------------------------------------------------------ projects

function viewProjects() {
  return `${head('Projects', 'Each project has its own workspace folder in the vault; agents only see their project.')}
  <section class="panel"><div class="table-wrap"><table class="table">
    <thead><tr><th>Project</th><th class="hide-sm">Workspace folder</th><th class="hide-md">Repositories</th><th></th></tr></thead>
    <tbody>${S.projects.map(p => `<tr>
      <td><div class="row">${icon('projects')}<b>${esc(p.name)}</b>${p.slug === S.project ? '<span class="pill s-DONE">current</span>' : ''}</div></td>
      <td class="hide-sm"><span class="path">${esc(p.workspace)}</span></td>
      <td class="hide-md">${p.roots.map(r => `<div class="path">${esc(r)}</div>`).join('') || '<span class="faint">—</span>'}</td>
      <td class="num">${p.slug === S.project ? '' : `<button class="btn sm" data-project="${esc(p.slug)}">Open</button>`}</td>
    </tr>`).join('')}</tbody>
  </table></div></section>
  <p class="faint" style="margin-top:12px">A repository registers itself on its first Claude Code session. Join another repository to a project with <span class="mono">wsc project register --name &lt;project&gt;</span>.</p>`
}

// ------------------------------------------------------------------ agents

function viewAgents() {
  const list = [...agents()].sort((a, b) => online(b) - online(a) || a.id.localeCompare(b.id))
  const mine = agents().find(a => isMe(a.id))
  return `${head('Agents', `${onlineAgents().length} online of ${agents().length}. Offline after ${S.data.config.staleAgentMinutes} minutes without activity.`,
    `<label class="row faint" style="gap:6px">Your status <select class="select" style="width:150px" data-change="my-status">${AGENT_STATUSES.map(s => `<option${(mine?.status ?? 'IDLE') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>`)}
  <section class="panel"><div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Current task</th><th scope="col" class="hide-md">Capabilities</th><th scope="col" class="hide-md">Session</th><th scope="col" class="hide-sm">Last activity</th><th scope="col" class="num">Requests</th></tr></thead>
    <tbody>${list.map(a => {
      const on = online(a)
      const start = parseTime(a.started)
      const end = on ? Date.now() : parseTime(a.lastActivity)
      const reqs = openRequestsFor(a.id).length
      return `<tr>
        <td><div class="row">${avatar(a.id, true)}<div><div><b>${esc(a.id)}</b>${isMe(a.id) ? ' <span class="faint">(you)</span>' : ''}</div><div class="faint" style="font-size:12px">${esc(a.kind)}${a.branch ? ` · ${esc(a.branch)}` : ''}</div></div></div></td>
        <td><div class="row" style="gap:6px"><span class="dot ${on ? 'live' : ''}" title="${on ? 'online' : 'offline'}"></span>${on ? pill(a.status) : '<span class="pill no-dot">offline</span>'}</div></td>
        <td><div class="truncate" style="max-width:340px">${esc(a.task || '—')}</div>${a.workingState ? `<div class="faint truncate" style="font-size:12px;max-width:340px">${esc(a.workingState)}</div>` : ''}</td>
        <td class="hide-md"><div class="tags">${(a.capabilities ?? []).map(c => `<span class="tag">${esc(c)}</span>`).join('') || '<span class="faint">—</span>'}</div></td>
        <td class="hide-md nowrap"${on ? ` data-tick="since" data-since="${start ?? ''}"` : ''}>${start === undefined ? '—' : duration(end - start)}</td>
        <td class="hide-sm nowrap" title="${esc(fullTime(a.lastActivity))}">${ago(a.lastActivity)}</td>
        <td class="num">${reqs ? `<span class="pill s-OPEN">${reqs}</span>` : '<span class="faint">0</span>'}</td>
      </tr>`
    }).join('') || `<tr><td colspan="7">${empty('No agent has registered yet. Claude Code sessions register by themselves; other tools: wsc agent-setup <tool>.', 'agents')}</td></tr>`}</tbody>
  </table></div></section>`
}

// ------------------------------------------------------------------ tasks

function viewTasks() {
  const q = S.board.q.toLowerCase()
  const owners = [...new Set(tasks().map(t => t.owner).filter(o => o && o !== '-'))].sort()
  const visible = tasks().filter(t => (!q || `${t.id} ${t.title} ${t.owner} ${t.notes}`.toLowerCase().includes(q)) && (!S.board.owner || (S.board.owner === '__none' ? !t.owner || t.owner === '-' : S.board.owner === '__me' ? isMe(t.owner) : t.owner === S.board.owner)))
  return `<div class="toolbar">
      <input class="input" placeholder="Filter tasks…" value="${esc(S.board.q)}" data-input="board-q" data-draft="board-q" aria-label="Filter tasks">
      <select class="select" data-change="board-owner" aria-label="Owner">
        <option value="">All owners</option><option value="__me"${S.board.owner === '__me' ? ' selected' : ''}>Mine (${esc(me())})</option><option value="__none"${S.board.owner === '__none' ? ' selected' : ''}>Unassigned</option>
        ${owners.map(o => `<option value="${esc(o)}"${S.board.owner === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
      <span class="faint">${visible.length} of ${tasks().length}</span>
      <div class="topbar-spacer"></div>
      <span class="faint hide-md">Drag cards between columns</span>
      <button class="btn primary" data-act="new-task">${icon('plus')}New task</button>
    </div>
    <div class="board">${COLUMNS.map(col => {
      const items = visible.filter(t => t.status === col.status)
      return `<section class="column" data-drop="${col.status}" aria-label="${col.label}">
        <div class="column-head"><span class="dot" style="background:${STATUS_COLOR[col.status]}"></span><b>${col.label}</b><span class="count">${items.length}</span></div>
        <div class="column-body">${items.map(card).join('') || `<div class="empty" style="padding:18px 8px">No tasks</div>`}</div>
      </section>`
    }).join('')}</div>`
}

function card(t) {
  const d = taskDuration(t)
  return `<article class="card${S.flash.has(t.id) ? ' flash' : ''}" draggable="true" data-task="${esc(t.id)}" tabindex="0" aria-label="${esc(`${t.id} ${t.title}, ${t.status.replace('_', ' ').toLowerCase()}${t.owner ? `, owner ${t.owner}` : ', unassigned'}. Enter for details`)}">
    <div class="card-top"><span class="card-id">${esc(t.id)}</span><button class="btn ghost sm icon-only card-menu" data-menu="${esc(t.id)}" aria-label="Task actions">${icon('more')}</button></div>
    <div class="card-title">${esc(t.title)}</div>
    ${t.progress !== undefined && t.status !== 'DONE' ? `<div class="bar"><i style="width:${t.progress}%;background:${STATUS_COLOR[t.status]}"></i></div>` : ''}
    ${t.depends.length ? `<div class="deps">Depends on ${t.depends.map(esc).join(', ')}</div>` : ''}
    <div class="card-meta">${avatar(t.owner)}<span class="truncate grow">${esc(t.owner && t.owner !== '-' ? t.owner : 'Unassigned')}</span>${d !== undefined ? `<span class="row nowrap" style="gap:4px" title="${t.status === 'DONE' ? 'Time to complete' : 'Time since started'}">${icon('clock')}${duration(d)}</span>` : ''}${t.progress !== undefined && t.status !== 'DONE' ? `<span class="nowrap">${t.progress}%</span>` : ''}</div>
  </article>`
}

/** Maps a move on the board to the protocol's own operations. */
function moveTask(id, status) {
  const t = tasks().find(x => x.id === id)
  if (!t || t.status === status) return
  const owned = t.owner && t.owner !== '-'
  if (status === 'DONE') return act('task.complete', { id }, { success: `${id} completed`, forceable: true })
  if (status === 'PENDING') return owned ? act('task.release', { id }, { success: `${id} released`, forceable: true }) : act('task.status', { id, status }, { forceable: true })
  if (status === 'IN_PROGRESS' && (!owned || !isMe(t.owner))) return act('task.claim', { id }, { success: `You claimed ${id}`, forceable: true })
  return act('task.status', { id, status }, { success: `${id} → ${status.replace('_', ' ').toLowerCase()}`, forceable: true })
}

function openTaskMenu(id, anchor) {
  const t = tasks().find(x => x.id === id)
  if (!t) return
  const mine = isMe(t.owner)
  const items = [
    !mine && t.status !== 'DONE' ? ['Claim', () => act('task.claim', { id }, { success: `You claimed ${id}`, forceable: true })] : null,
    ...COLUMNS.filter(c => c.status !== t.status).map(c => [`Move to ${c.label}`, () => moveTask(id, c.status)]),
    t.status !== 'DONE' ? ['Set progress…', () => progressDialog(t)] : null,
    null,
    mine ? ['Release', () => act('task.release', { id }, { success: `${id} released` })] : null,
    t.owner && t.owner !== '-' && !mine ? [`Message ${t.owner}`, () => composeTo(t.owner, `About ${t.id} (${t.title}): `)] : null,
  ]
  menu(anchor, items)
}

// ------------------------------------------------------------------ communication

function viewComms() {
  const snap = S.data.snapshot
  const openReq = snap.requests.filter(r => r.status === 'OPEN').length
  const tabs = `<div class="tabs">
    <button class="tab${S.comms.tab === 'messages' ? ' on' : ''}" data-comms-tab="messages">Messages <span class="count">${snap.messages.length}</span></button>
    <button class="tab${S.comms.tab === 'requests' ? ' on' : ''}" data-comms-tab="requests">Requests <span class="count">${openReq} open</span></button>
    <div class="topbar-spacer"></div>
    ${S.comms.tab === 'requests' ? `<button class="btn sm" data-act="new-request">${icon('plus')}New</button>` : ''}
  </div>`
  return S.comms.tab === 'messages' ? commsMessages(tabs) : commsRequests(tabs)
}

function recipients(includeAll = true) {
  const ids = agents().filter(a => !isMe(a.id)).map(a => a.id)
  return `${includeAll ? '<option value="ALL">ALL (broadcast)</option>' : ''}${ids.map(id => `<option value="${esc(id)}">${esc(id)}${agents().find(a => a.id === id && online(a)) ? '' : ' (offline)'}</option>`).join('')}`
}

function commsMessages(tabs) {
  const f = S.comms.filter
  const list = S.data.snapshot.messages.filter(m => f === 'all' || (f === 'me' ? isMe(m.to) || isMe(m.from) : m.to.toUpperCase() === 'ALL'))
  return `<div class="split">
    <div class="pane">${tabs}
      <div class="tabs"><div class="seg">${[['all', 'All'], ['me', 'To or from me'], ['all-agents', 'Broadcasts']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-msg-filter="${k}">${l}</button>`).join('')}</div></div>
      <div class="pane-scroll" data-scroll="msg-side">
        ${agents().length ? agents().map(a => {
          const last = [...S.data.snapshot.messages].reverse().find(m => m.from === a.id || m.to === a.id)
          return `<div class="thread-item" data-compose="${esc(a.id)}">${avatar(a.id)}<div class="grow"><div class="row"><b>${esc(a.id)}</b>${online(a) ? '<span class="dot live"></span>' : ''}<span class="faint" style="margin-left:auto;font-size:12px">${last ? ago(last.timestamp) : ''}</span></div><div class="preview">${last ? esc(last.body) : '<span class="faint">No messages yet</span>'}</div></div></div>`
        }).join('') : empty('No agents yet.', 'agents')}
      </div>
    </div>
    <div class="pane">
      <div class="pane-scroll" data-scroll="msgs">
        ${list.length ? list.map(m => `<div class="msg${isMe(m.from) ? ' mine' : ''}">${avatar(m.from, true)}<div class="grow"><div class="msg-head"><span class="msg-from">${esc(m.from)}</span><span class="msg-to">→ ${esc(m.to)}</span><span class="mono faint">${esc(m.id)}</span><span class="msg-time" title="${esc(fullTime(m.timestamp))}">${ago(m.timestamp)}</span></div><div class="msg-body">${esc(m.body)}</div></div></div>`).join('') : empty('No messages. Messages are appended to MESSAGES.md.', 'messages')}
      </div>
      <form class="composer" data-form="message">
        <div class="row"><span class="faint">To</span><select class="select" style="width:220px" name="to" data-draft="msg-to">${recipients()}</select><span class="faint hide-sm" style="margin-left:auto">⌘/Ctrl + Enter to send</span></div>
        <textarea class="textarea" name="body" placeholder="Write a message… it is appended to MESSAGES.md" data-draft="msg-body" required></textarea>
        <div class="row"><span class="faint">Sending as <b>${esc(me())}</b></span><button class="btn primary" style="margin-left:auto" type="submit">${icon('send')}Send</button></div>
      </form>
    </div>
  </div>`
}

function commsRequests(tabs) {
  const f = S.comms.reqFilter
  const list = [...S.data.snapshot.requests].reverse().filter(r => f === 'all' || (f === 'open' ? r.status === 'OPEN' : f === 'me' ? isMe(r.to) || r.to.toUpperCase() === 'ALL' : r.status !== 'OPEN'))
  const selected = S.data.snapshot.requests.find(r => r.id === S.comms.selected) ?? list[0]
  return `<div class="split">
    <div class="pane">${tabs}
      <div class="tabs"><div class="seg">${[['open', 'Open'], ['me', 'For me'], ['done', 'Answered'], ['all', 'All']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-req-filter="${k}">${l}</button>`).join('')}</div></div>
      <div class="pane-scroll" data-scroll="req-side">
        ${list.map(r => `<div class="thread-item${selected?.id === r.id ? ' on' : ''}" data-select-request="${esc(r.id)}"><div class="grow"><div class="row"><span class="mono faint">${esc(r.id)}</span>${pill(r.status)}<span class="faint" style="margin-left:auto;font-size:12px">${ago(r.updated || r.created)}</span></div><div class="truncate" style="margin-top:2px"><b>${esc(r.title)}</b></div><div class="faint" style="font-size:12px">${esc(r.from)} → ${esc(r.to)} · ${esc(r.priority.toLowerCase())}</div></div></div>`).join('') || empty('No requests here.', 'messages')}
      </div>
    </div>
    <div class="pane"><div class="pane-scroll" data-scroll="req-detail">${selected ? requestDetail(selected) : empty('Select a request.', 'messages')}</div></div>
  </div>`
}

function requestDetail(r) {
  const canAnswer = r.status !== 'CLOSED'
  return `<div class="detail">
    <div><div class="row"><span class="mono faint">${esc(r.id)}</span>${pill(r.status)}${pill(r.priority)}</div><h2 style="margin-top:6px">${esc(r.title)}</h2></div>
    <dl class="kv"><dt>From</dt><dd>${esc(r.from)}</dd><dt>To</dt><dd>${esc(r.to)}</dd><dt>Created</dt><dd title="${esc(fullTime(r.created))}">${ago(r.created)}</dd><dt>Updated</dt><dd>${ago(r.updated)}</dd></dl>
    <div class="quote">${esc(r.question)}</div>
    ${r.answers.map(a => `<div class="answer"><div class="row"><b>${esc(a.agent)}</b><span class="faint" title="${esc(fullTime(a.timestamp))}">${esc(a.timestamp)}</span></div><div class="msg-body">${esc(a.body)}</div></div>`).join('')}
    ${canAnswer ? `<form class="stack" data-form="answer" data-id="${esc(r.id)}">
      <textarea class="textarea" name="answer" placeholder="Answer as ${esc(me())}… appended under ### Answer in REQUESTS.md" data-draft="answer-${esc(r.id)}" required></textarea>
      <div class="row"><label class="row faint" style="gap:6px"><input type="checkbox" name="close"> Close after answering</label><div class="topbar-spacer"></div>
      ${r.status !== 'CLOSED' ? `<button class="btn" type="button" data-close-request="${esc(r.id)}">${icon('check')}Close</button>` : ''}<button class="btn primary" type="submit">${icon('send')}Answer</button></div>
    </form>` : '<p class="faint">This request is closed.</p>'}
  </div>`
}

// ------------------------------------------------------------------ activity

function viewActivity() {
  const g = S.activity.group
  const events = S.data.snapshot.events.filter(e => (g === 'all' || EVENT_GROUPS[g]?.includes(e.type)) && (!S.activity.agent || e.agent === S.activity.agent)).reverse()
  const agentsInLog = [...new Set(S.data.snapshot.events.map(e => e.agent))].sort()
  const colors = { tasks: 'var(--progress)', comms: 'var(--waiting)', agents: 'var(--text-3)', progress: 'var(--done)' }
  const colorOf = type => colors[Object.keys(EVENT_GROUPS).find(k => EVENT_GROUPS[k].includes(type))] ?? 'var(--text-3)'
  let day = ''
  const rows = events.map(e => {
    const t = parseTime(e.timestamp)
    const d = t === undefined ? '' : new Date(t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    const header = d !== day ? `<div class="feed-day">${esc(d)}</div>` : ''
    day = d
    return `${header}<div class="event${S.seenEvents.size && !S.seenEvents.has(e.id) ? ' new' : ''}"><span class="event-time">${hhmm(e.timestamp)}</span><span class="event-dot"><i style="background:${colorOf(e.type)}"></i></span><div class="event-text"><b>${esc(e.agent)}</b> ${esc(e.summary)}<span class="event-type">${esc(e.type)}</span></div></div>`
  })
  return `${head('Activity', 'Every action in the workspace, newest first, from SESSION_LOG.md. Updates live.',
    `<div class="seg">${[['all', 'All'], ['tasks', 'Tasks'], ['comms', 'Communication'], ['agents', 'Sessions'], ['progress', 'Milestones & commits']].map(([k, l]) => `<button class="${g === k ? 'on' : ''}" data-activity-group="${k}">${l}</button>`).join('')}</div>
     <select class="select" style="width:160px" data-change="activity-agent"><option value="">All agents</option>${agentsInLog.map(a => `<option${S.activity.agent === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>`)}
  <div class="feed">${rows.join('') || empty('No events match.', 'activity')}</div>`
}

// ------------------------------------------------------------------ plan & milestones

function markdown(text) {
  const lines = String(text).replace(/<!--[\s\S]*?-->/g, '').split('\n')
  const out = []
  let list = false
  let code = false
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<span class="wikilink">${b ?? a}</span>`)
  const closeList = () => {
    if (list) out.push('</ul>')
    list = false
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      closeList()
      out.push(code ? '</pre>' : '<pre>')
      code = !code
      continue
    }
    if (code) {
      out.push(esc(line) + '\n')
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    } else if (task || item) {
      if (!list) out.push('<ul>')
      list = true
      out.push(task ? `<li class="task${task[1] !== ' ' ? ' done' : ''}"><span class="box"></span><span>${inline(task[2])}</span></li>` : `<li>${inline(item[1])}</li>`)
    } else if (line.trim()) {
      closeList()
      out.push(`<p>${inline(line)}</p>`)
    } else closeList()
  }
  closeList()
  if (code) out.push('</pre>')
  return out.join('')
}

function viewMilestones() {
  const ms = [...S.data.snapshot.milestones].reverse()
  return `${head('Plan & Milestones', 'PLAN.md and MILESTONES.md of this project.', `<button class="btn" data-act="new-plan">${icon('plus')}New plan</button><button class="btn primary" data-act="new-milestone">${icon('milestones')}Add milestone</button>`)}
  <div class="grid-2">
    <section class="panel"><div class="panel-head"><span class="panel-title">Current plan</span></div><div class="panel-body md">${S.data.snapshot.plan.trim() ? markdown(S.data.snapshot.plan) : empty('No plan yet.', 'milestones')}</div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Milestones</span><span class="faint" style="margin-left:auto">${ms.length}</span></div><div class="panel-body">
      ${ms.length ? `<div class="timeline">${ms.map(m => `<div class="tl-item"><span class="tl-dot"></span><div><div class="row"><b>${esc(m.title)}</b></div><div class="faint" style="font-size:12px">${esc(m.id)} · ${esc(m.agent)} · <span title="${esc(fullTime(m.timestamp))}">${ago(m.timestamp)}</span></div>${m.note ? `<div class="muted" style="margin-top:4px">${esc(m.note)}</div>` : ''}</div></div>`).join('')}</div>` : empty('No milestones yet.', 'milestones')}
    </div></section>
  </div>`
}

// ------------------------------------------------------------------ git

function viewGit() {
  const git = S.data.git
  const toggle = `<button class="btn" data-act="toggle-git">${icon(S.gitVisible ? 'eye-off' : 'eye')}${S.gitVisible ? 'Hide Git' : 'Show Git'}</button>`
  if (!S.gitVisible) return `${head('Git history', 'Hidden on this dashboard.', toggle)}<section class="panel"><div class="hidden-note">${icon('eye-off')}The Git panel is hidden. Use Show Git to bring it back.</div></section>`
  return `${head('Git history', git.available ? `Branch <span class="mono">${esc(git.branch || '—')}</span> · latest ${git.commits.length} commits · updates when .git changes` : 'No Git repository found for this project.', toggle)}
  <section class="panel">${git.available && git.commits.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>Commit</th><th>Message</th><th class="hide-sm">Author</th><th class="hide-md">Agent</th><th class="num">When</th></tr></thead>
    <tbody>${git.commits.map(c => `<tr><td><span class="commit-hash">${esc(c.hash)}</span></td><td>${esc(c.subject)}</td><td class="hide-sm muted">${esc(c.author)}</td><td class="hide-md">${c.agent ? `<div class="row">${avatar(c.agent)}${esc(c.agent)}</div>` : '<span class="faint">—</span>'}</td><td class="num nowrap muted" title="${esc(fullTime(c.date))}">${ago(c.date)}</td></tr>`).join('')}</tbody>
  </table></div>` : `<div class="panel-body tight">${commitRows(5)}</div>`}</section>`
}

// ------------------------------------------------------------------ settings

function viewSettings() {
  const cfg = S.data.config
  const sw = (key, on, title, sub) => `<div class="setting"><div class="grow"><div>${title}</div><div>${sub}</div></div><button class="switch" role="switch" aria-checked="${on}" data-toggle="${key}" aria-label="${esc(title)}"></button></div>`
  return `${head('Settings', 'Dashboard preferences are stored in this browser. Workspace settings come from the Workspace Commander config.')}
  <div class="settings">
    <section class="panel"><div class="panel-head"><span class="panel-title">Identity</span></div>
      <form class="panel-body stack" data-form="identity">
        <div class="field"><label for="as">Act as</label><div class="row"><input class="input" id="as" name="as" value="${esc(me())}" pattern="[A-Za-z][\\w.\\-]{0,40}" style="max-width:240px"><button class="btn" type="submit">Save</button></div>
        <div class="hint">Tasks you claim, messages you send and answers you give are written under this agent ID, as kind <span class="mono">human</span>. The server default is <span class="mono">${esc(S.data.identity)}</span> (<span class="mono">--as</span>).</div></div>
      </form>
    </section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Display</span></div>
      ${sw('gitVisible', S.gitVisible, 'Show Git panel', 'Latest commits on the overview and the Git page. This dashboard\'s own switch; /togglegit controls the Claude Code pane.')}
      ${sw('compact', S.compact, 'Compact density', 'Tighter rows in lists and tables.')}
      ${sw('collapsed', S.collapsed, 'Collapse sidebar', 'Icons only. Also with the button at the bottom of the sidebar.')}
    </section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Workspace</span></div><div class="panel-body"><dl class="kv">
      <dt>Project</dt><dd>${esc(S.data.project.name)}</dd>
      <dt>Workspace</dt><dd class="path">${esc(cfg.workspace)}</dd>
      <dt>Vault</dt><dd class="path">${esc(cfg.vault)}</dd>
      <dt>Protocol</dt><dd class="path">${esc(cfg.protocol)}</dd>
      <dt>Config</dt><dd class="path">${cfg.configSources.map(esc).join('<br>') || 'defaults'}</dd>
      <dt>Projects</dt><dd class="path">${esc(cfg.registry)}</dd>
      <dt>Offline after</dt><dd>${cfg.staleAgentMinutes} minutes without activity</dd>
    </dl></div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Keyboard</span></div><div class="panel-body shortcuts">
      <span class="kbd">⌘K</span><span>Search and commands (also Ctrl+K or /)</span>
      <span class="kbd">G then O/T/A/M/C/G/S</span><span>Overview, Tasks, Agents, Messages, Activity, Git, Settings</span>
      <span class="kbd">N</span><span>New task</span>
      <span class="kbd">Esc</span><span>Close dialogs and menus</span>
    </div></section>
  </div>`
}

// ------------------------------------------------------------------ overlays

function toast(text, kind = '', actions = []) {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.innerHTML = `${icon(kind === 'error' ? 'help' : 'check')}<div class="grow">${esc(text)}${actions.length ? `<div class="toast-actions">${actions.map((a, i) => `<button class="btn sm" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div><button class="btn ghost sm icon-only" aria-label="Dismiss">${icon('x')}</button>`
  el.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.i !== undefined) actions[Number(b.dataset.i)].run()
    el.remove()
  })
  document.getElementById('toasts').append(el)
  setTimeout(() => el.remove(), actions.length ? 9000 : 4200)
}

let menuEl
function closeMenu() {
  menuEl?.remove()
  menuEl = undefined
}
function menu(anchor, items) {
  closeMenu()
  menuEl = document.createElement('div')
  menuEl.className = 'menu'
  menuEl.setAttribute('role', 'menu')
  const runs = []
  menuEl.innerHTML = items.map(item => {
    if (item === null) return '<hr>'
    if (!item) return ''
    runs.push(item[1])
    return `<button role="menuitem" data-i="${runs.length - 1}">${esc(item[0])}</button>`
  }).join('').replace(/^(<hr>)+|(<hr>)+$/g, '').replace(/(<hr>){2,}/g, '<hr>')
  document.body.append(menuEl)
  const r = anchor.getBoundingClientRect()
  const w = menuEl.offsetWidth
  const h = menuEl.offsetHeight
  menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  menuEl.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`
  menuEl.addEventListener('click', e => {
    const b = e.target.closest('[data-i]')
    if (!b) return
    closeMenu()
    runs[Number(b.dataset.i)]()
  })
  menuEl.querySelector('button')?.focus()
}

function modal(title, body, submitLabel, onSubmit) {
  const root = document.getElementById('modal-root')
  root.innerHTML = `<div class="overlay" data-overlay><form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head">${esc(title)}<button type="button" class="btn ghost sm icon-only" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div>
  </form></div>`
  const form = root.querySelector('form')
  const close = () => (root.innerHTML = '')
  root.querySelector('[data-overlay]').addEventListener('mousedown', e => e.target.dataset.overlay !== undefined && close())
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close))
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const button = form.querySelector('[type=submit]')
    button.disabled = true
    const ok = await onSubmit(new FormData(form))
    button.disabled = false
    if (ok !== false) close()
  })
  form.querySelector('input, textarea, select')?.focus()
}

function newTaskDialog() {
  const open = tasks().filter(t => t.status !== 'DONE')
  modal('New task', `
    <div class="field"><label for="t-title">Title</label><input class="input" id="t-title" name="title" required maxlength="300" placeholder="Implement the login form"><div class="hint">A task with the same title that is still open is reused instead of duplicated.</div></div>
    <div class="field"><label for="t-dep">Depends on</label><select class="select" id="t-dep" name="depends"><option value="">Nothing</option>${open.map(t => `<option value="${esc(t.id)}">${esc(t.id)} · ${esc(t.title)}</option>`).join('')}</select></div>
    <label class="row faint" style="gap:6px"><input type="checkbox" name="claim"> Claim it as ${esc(me())}</label>`, 'Create task', async fd => {
    const data = await act('task.add', { title: fd.get('title'), depends: fd.get('depends') ? [fd.get('depends')] : [] }, { success: r => (r.created ? `Created ${r.task.id}` : `${r.task.id} already exists with this title`) })
    if (!data) return false
    if (fd.get('claim')) await act('task.claim', { id: data.task.id }, { forceable: true })
  })
}

function progressDialog(t) {
  modal(`Progress · ${t.id}`, `<div class="field"><label for="p">Progress (%)</label><input class="input" id="p" name="progress" type="number" min="0" max="100" value="${t.progress ?? 0}"></div>
    <div class="field"><label for="pn">Note (optional)</label><input class="input" id="pn" name="note"></div>`, 'Update', async fd => {
    const status = t.status === 'PENDING' ? 'IN_PROGRESS' : t.status
    return (await act('task.status', { id: t.id, status, progress: Number(fd.get('progress')), note: fd.get('note') || undefined }, { success: `${t.id} updated`, forceable: true })) !== undefined
  })
}

function newRequestDialog() {
  modal('New request', `
    <div class="field"><label for="r-to">To</label><select class="select" id="r-to" name="to">${recipients()}</select></div>
    <div class="field"><label for="r-title">Title</label><input class="input" id="r-title" name="title" maxlength="200" required></div>
    <div class="field"><label for="r-p">Priority</label><select class="select" id="r-p" name="priority">${['LOW', 'NORMAL', 'HIGH', 'URGENT'].map(p => `<option${p === 'NORMAL' ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="field"><label for="r-q">Question</label><textarea class="textarea" id="r-q" name="question" required></textarea></div>`, 'Create request', async fd => {
    const r = await act('request.create', { to: fd.get('to'), title: fd.get('title'), priority: fd.get('priority'), question: fd.get('question') }, { success: r => `Created ${r.id}` })
    if (!r) return false
    S.comms = { ...S.comms, tab: 'requests', selected: r.id }
    go('messages')
  })
}

function newPlanDialog() {
  modal('New plan', `
    <p class="faint" style="margin:0">Replaces PLAN.md. The current plan is archived to PLANS/ first, and every line becomes a task (existing open tasks with the same title are reused).</p>
    <div class="field"><label for="pl-o">Objective</label><input class="input" id="pl-o" name="objective" required></div>
    <div class="field"><label for="pl-t">Tasks, one per line</label><textarea class="textarea" id="pl-t" name="tasks" rows="6"></textarea></div>`, 'Create plan', async fd => {
    return (await act('plan.create', { objective: fd.get('objective'), tasks: String(fd.get('tasks') || '').split('\n') }, { success: r => `Plan written with ${r.tasks.length} tasks` })) !== undefined
  })
}

function newMilestoneDialog() {
  modal('Add milestone', `<div class="field"><label for="m-t">Title</label><input class="input" id="m-t" name="title" required maxlength="300"></div>
    <div class="field"><label for="m-n">Note (optional)</label><textarea class="textarea" id="m-n" name="note"></textarea></div>`, 'Add', async fd => {
    return (await act('milestone.add', { title: fd.get('title'), note: fd.get('note') || '' }, { success: r => `${r.id} recorded` })) !== undefined
  })
}

function composeTo(id, text = '') {
  S.comms.tab = 'messages'
  go('messages')
  const to = document.querySelector('[data-draft="msg-to"]')
  const body = document.querySelector('[data-draft="msg-body"]')
  if (to) to.value = id
  if (body) {
    if (text) body.value = text
    body.focus()
  }
}

function toggleGit() {
  S.gitVisible = !S.gitVisible
  prefs.set('gitVisible', S.gitVisible)
  toast(`Git panel: ${S.gitVisible ? 'visible' : 'hidden'}`)
  render()
}

// ------------------------------------------------------------------ command palette

function paletteItems(q) {
  const items = []
  const add = (group, label, ic, run, hint = '') => items.push({ group, label, ic, run, hint })
  for (const v of VIEWS) add('Go to', v.label, v.icon, () => go(v.id))
  add('Actions', 'New task', 'plus', newTaskDialog, 'N')
  add('Actions', 'New request', 'messages', newRequestDialog)
  add('Actions', 'Send a message', 'send', () => composeTo('ALL'))
  add('Actions', 'Add milestone', 'milestones', newMilestoneDialog)
  add('Actions', S.gitVisible ? 'Hide Git panel' : 'Show Git panel', S.gitVisible ? 'eye-off' : 'eye', toggleGit)
  for (const p of S.projects) if (p.slug !== S.project) add('Projects', `Switch to ${p.name}`, 'projects', () => switchProject(p.slug))
  if (q) {
    for (const t of tasks()) add('Tasks', `${t.id} ${t.title}`, 'tasks', () => { go('tasks'); setTimeout(() => focusCard(t.id), 30) }, t.status.replace('_', ' ').toLowerCase())
    for (const a of agents()) add('Agents', a.id, 'agents', () => go('agents'), online(a) ? a.status.toLowerCase() : 'offline')
    for (const r of S.data?.snapshot.requests ?? []) add('Requests', `${r.id} ${r.title}`, 'messages', () => { S.comms = { ...S.comms, tab: 'requests', selected: r.id, reqFilter: 'all' }; go('messages') }, r.status.toLowerCase())
    for (const m of S.data?.snapshot.messages ?? []) add('Messages', `${m.from} → ${m.to}: ${m.body}`, 'messages', () => { S.comms.tab = 'messages'; go('messages') }, m.id)
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(i => words.every(w => i.label.toLowerCase().includes(w) || i.group.toLowerCase().includes(w))).slice(0, 40)
}

function openPalette() {
  const root = document.getElementById('palette-root')
  root.innerHTML = `<div class="overlay" data-overlay><div class="palette" role="dialog" aria-label="Command palette"><div class="palette-input">${icon('search')}<input placeholder="Search tasks, agents, requests, messages, or run a command…" aria-label="Search"><span class="kbd">Esc</span></div><div class="palette-list" role="listbox"></div></div></div>`
  const input = root.querySelector('input')
  const list = root.querySelector('.palette-list')
  let items = []
  let index = 0
  const close = () => (root.innerHTML = '')
  const draw = () => {
    items = paletteItems(input.value.trim())
    index = Math.min(index, Math.max(items.length - 1, 0))
    let group = ''
    list.innerHTML = items.map((it, i) => {
      const g = it.group !== group ? `<div class="palette-group">${esc(it.group)}</div>` : ''
      group = it.group
      return `${g}<div class="palette-item${i === index ? ' on' : ''}" role="option" data-i="${i}">${icon(it.ic)}<span class="truncate">${esc(it.label)}</span><span class="hint">${esc(it.hint)}</span></div>`
    }).join('') || '<div class="empty">Nothing found</div>'
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  const run = i => {
    const it = items[i]
    if (!it) return
    close()
    it.run()
  }
  input.addEventListener('input', () => {
    index = 0
    draw()
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { index = Math.min(index + 1, items.length - 1); draw(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { index = Math.max(index - 1, 0); draw(); e.preventDefault() }
    else if (e.key === 'Enter') { run(index); e.preventDefault() }
    else if (e.key === 'Escape') close()
  })
  list.addEventListener('click', e => {
    const el = e.target.closest('[data-i]')
    if (el) run(Number(el.dataset.i))
  })
  root.querySelector('[data-overlay]').addEventListener('mousedown', e => e.target.dataset.overlay !== undefined && close())
  draw()
  input.focus()
}

function focusCard(id) {
  const el = document.querySelector(`[data-task="${CSS.escape(id)}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  el.classList.add('flash')
  el.focus()
}

// ------------------------------------------------------------------ task details

function openTask(id, returnTo = document.activeElement) {
  S.detail = id
  S.detailReturn = returnTo instanceof HTMLElement ? returnTo : null
  renderDrawer()
  document.querySelector('.drawer')?.focus()
}

function closeTask() {
  if (!S.detail) return false
  const back = S.detailReturn
  S.detail = null
  S.detailReturn = null
  renderDrawer()
  // The card may have been re-rendered meanwhile: refocus it by id.
  const card = back?.dataset?.task ? document.querySelector(`[data-task="${CSS.escape(back.dataset.task)}"]`) : back
  card?.focus?.()
  return true
}

/** Drawn on every render, so the open task follows live changes. */
function renderDrawer() {
  const root = document.getElementById('drawer-root')
  if (!root) return
  if (!S.detail || !S.data) {
    root.innerHTML = ''
    return
  }
  const keepScroll = root.querySelector('.drawer-body')?.scrollTop
  const hadFocus = root.contains(document.activeElement)
  const t = tasks().find(x => x.id === S.detail)
  root.innerHTML = `<div class="drawer-scrim" data-act="close-task"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">
      <div class="drawer-head"><span class="mono faint">${esc(S.detail)}</span><h2 id="drawer-title" class="grow truncate">${esc(t?.title ?? 'Task not found')}</h2><button class="btn ghost sm icon-only" data-act="close-task" aria-label="Close details">${icon('x')}</button></div>
      <div class="drawer-body">${t ? taskDetail(t) : empty(`${S.detail} is no longer in TASKS.md.`, 'tasks')}</div>
    </aside>`
  if (keepScroll) root.querySelector('.drawer-body').scrollTop = keepScroll
  if (hadFocus) root.querySelector('.drawer')?.focus()
}

function taskDetail(t) {
  const owned = t.owner && t.owner !== '-'
  const mine = isMe(t.owner)
  const ownerAgent = agents().find(a => a.id === t.owner)
  const d = taskDuration(t)
  const field = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`
  const time = iso => (iso ? `<span title="${esc(fullTime(iso))}">${esc(fullTime(iso))} · ${ago(iso)}</span>` : '<span class="faint">—</span>')
  const history = (S.data.snapshot.events ?? []).filter(e => e.ref === t.id).slice(-30).reverse()
  const blocking = tasks().filter(x => x.depends.includes(t.id))
  const actions = [
    !mine && t.status !== 'DONE' ? `<button class="btn primary" data-detail="claim">${owned ? `Take over from ${esc(t.owner)}` : 'Claim'}</button>` : '',
    t.status !== 'DONE' ? `<button class="btn" data-detail="progress">Set progress…</button>` : '',
    `<label class="row" style="gap:6px"><span class="faint">Move to</span><select class="select" data-change="detail-move" aria-label="Move to column"><option value="">—</option>${COLUMNS.filter(c => c.status !== t.status).map(c => `<option value="${c.status}">${c.label}</option>`).join('')}</select></label>`,
    mine ? `<button class="btn" data-detail="release">Release</button>` : '',
    owned && !mine ? `<button class="btn" data-detail="message">Message ${esc(t.owner)}</button>` : '',
  ].filter(Boolean)
  return `<div class="row" style="gap:8px;flex-wrap:wrap">${pill(t.status)}${owned ? `${avatar(t.owner)}<b>${esc(t.owner)}</b>${ownerAgent ? `<span class="faint">${esc(ownerAgent.kind)} · ${online(ownerAgent) ? 'online' : 'offline'}</span>` : '<span class="faint">not in AGENTS.md</span>'}` : '<span class="faint">Unassigned</span>'}</div>
    ${t.progress !== undefined ? `<div class="bar" style="margin-top:12px" role="progressbar" aria-valuenow="${t.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><i style="width:${t.progress}%;background:${STATUS_COLOR[t.status]}"></i></div>` : ''}
    <div class="detail-actions">${actions.join('')}</div>
    <dl class="kv">
      ${field('Progress', t.progress === undefined ? '<span class="faint">—</span>' : `${t.progress}%`)}
      ${field('Depends on', t.depends.length ? t.depends.map(dep => `<button class="link" data-detail-open="${esc(dep)}">${esc(dep)}</button> ${(() => { const x = tasks().find(y => y.id === dep); return x ? pill(x.status) : '<span class="faint">unknown</span>' })()}`).join(' ') : '<span class="faint">nothing</span>')}
      ${field('Blocks', blocking.length ? blocking.map(x => `<button class="link" data-detail-open="${esc(x.id)}">${esc(x.id)}</button>`).join(' ') : '<span class="faint">nothing</span>')}
      ${field('Created', time(t.created))}
      ${field('Started', time(t.started))}
      ${field('Updated', time(t.updated))}
      ${field('Completed', time(t.completed))}
      ${d !== undefined ? field(t.status === 'DONE' ? 'Took' : 'Running for', esc(duration(d))) : ''}
    </dl>
    <h3 class="detail-h">Notes</h3>
    <div class="md">${t.notes ? markdown(t.notes) : '<p class="faint">No notes. Agents add them with task_update or task_complete notes.</p>'}</div>
    <h3 class="detail-h">History</h3>
    ${history.length ? `<ol class="history">${history.map(e => `<li><span class="mono faint nowrap">${esc(hhmm(e.timestamp))}</span> <b>${esc(e.agent)}</b> <span class="muted">${esc(e.summary)}</span></li>`).join('')}</ol>` : '<p class="faint">No recorded events for this task in the recent log.</p>'}`
}

/** Keeps Tab inside the topmost open dialog (modal, palette, then the drawer). */
function trapFocus(e) {
  const dialog = document.querySelector('#modal-root [role=dialog], #palette-root [role=dialog], #drawer-root [role=dialog]')
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!dialog.contains(document.activeElement)) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

// ------------------------------------------------------------------ events

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go],[data-act],[data-menu],[data-project],[data-comms-tab],[data-msg-filter],[data-req-filter],[data-select-request],[data-close-request],[data-compose],[data-open-task],[data-open-request],[data-activity-group],[data-toggle],[data-detail],[data-detail-open]')
  if (!e.target.closest('.menu')) closeMenu()
  if (!t) {
    const card = e.target.closest('[data-task]')
    if (card && !card.classList.contains('dragging')) openTask(card.dataset.task, card)
    return
  }
  const d = t.dataset
  if (d.detailOpen) return openTask(d.detailOpen, S.detailReturn)
  if (d.detail) {
    const task = tasks().find(x => x.id === S.detail)
    if (!task) return
    if (d.detail === 'claim') return act('task.claim', { id: task.id }, { success: `You claimed ${task.id}`, forceable: true })
    if (d.detail === 'progress') return progressDialog(task)
    if (d.detail === 'release') return act('task.release', { id: task.id }, { success: `${task.id} released` })
    if (d.detail === 'message') { closeTask(); return composeTo(task.owner, `About ${task.id} (${task.title}): `) }
  }
  if (d.go) return go(d.go)
  if (d.menu) return openTaskMenu(d.menu, t)
  if (d.project) return switchProject(d.project)
  if (d.commsTab) { S.comms.tab = d.commsTab; return render() }
  if (d.msgFilter) { S.comms.filter = d.msgFilter; return render() }
  if (d.reqFilter) { S.comms.reqFilter = d.reqFilter; S.comms.selected = null; return render() }
  if (d.selectRequest) { S.comms.selected = d.selectRequest; return render() }
  if (d.closeRequest) return act('request.close', { id: d.closeRequest }, { success: `${d.closeRequest} closed` })
  if (d.compose) return composeTo(d.compose)
  if (d.openTask) { go('tasks'); return setTimeout(() => { focusCard(d.openTask); openTask(d.openTask, document.querySelector(`[data-task="${CSS.escape(d.openTask)}"]`)) }, 30) }
  if (d.openRequest) { S.comms = { ...S.comms, tab: 'requests', selected: d.openRequest, reqFilter: 'all' }; return go('messages') }
  if (d.activityGroup) { S.activity.group = d.activityGroup; return render() }
  if (d.toggle) {
    if (d.toggle === 'gitVisible') return toggleGit()
    S[d.toggle] = !S[d.toggle]
    prefs.set(d.toggle, S[d.toggle])
    return render()
  }
  switch (d.act) {
    case 'collapse': S.collapsed = !S.collapsed; prefs.set('collapsed', S.collapsed); return render()
    case 'open-nav': S.navOpen = true; return render()
    case 'close-nav': S.navOpen = false; return render()
    case 'palette': return openPalette()
    case 'close-task': return closeTask()
    case 'retry': S.error = ''; render(); connectLive(); return refresh()
    case 'new-task': return newTaskDialog()
    case 'new-request': return newRequestDialog()
    case 'new-plan': return newPlanDialog()
    case 'new-milestone': return newMilestoneDialog()
    case 'toggle-git': return toggleGit()
    case 'comms-requests': S.comms = { ...S.comms, tab: 'requests', reqFilter: 'open' }; return go('messages')
  }
})

document.addEventListener('change', e => {
  const d = e.target.dataset
  if (d.change === 'project') return switchProject(e.target.value)
  if (d.change === 'board-owner') { S.board.owner = e.target.value; return render() }
  if (d.change === 'activity-agent') { S.activity.agent = e.target.value; return render() }
  if (d.change === 'detail-move' && e.target.value && S.detail) return moveTask(S.detail, e.target.value)
  if (d.change === 'my-status') return act('agent.status', { status: e.target.value }, { success: `You are ${e.target.value}` })
})

let filterTimer
document.addEventListener('input', e => {
  if (e.target.dataset.input === 'board-q') {
    S.board.q = e.target.value
    clearTimeout(filterTimer)
    filterTimer = setTimeout(render, 120)
  }
})

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]')
  if (!form) return
  e.preventDefault()
  const fd = new FormData(form)
  const kind = form.dataset.form
  if (kind === 'identity') {
    const value = String(fd.get('as') || '').trim()
    if (!/^[A-Za-z][\w.-]{0,40}$/.test(value)) return toast('An agent ID starts with a letter: Human-01, Saad, …', 'error')
    S.as = value === S.data.identity ? '' : value
    prefs.set('as', S.as)
    toast(`Acting as ${me()}`, 'ok')
    return render()
  }
  if (kind === 'message') {
    const sent = await act('message.send', { to: fd.get('to'), body: fd.get('body') }, { success: m => `${m.id} sent to ${m.to}` })
    if (sent) {
      const body = document.querySelector('[data-draft="msg-body"]')
      if (body) body.value = ''
      document.querySelector('[data-scroll="msgs"]')?.scrollTo(0, 1e9)
    }
  }
  if (kind === 'answer') {
    const done = await act('request.answer', { id: form.dataset.id, answer: fd.get('answer'), close: fd.get('close') === 'on' }, { success: r => `Answered ${r.id}` })
    if (done) {
      const el = document.querySelector(`[data-draft="answer-${CSS.escape(form.dataset.id)}"]`)
      if (el) el.value = ''
    }
  }
})

// Drag and drop on the board.
let dragged
document.addEventListener('dragstart', e => {
  const c = e.target.closest?.('[data-task]')
  if (!c) return
  dragged = c.dataset.task
  c.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragged)
})
document.addEventListener('dragend', e => {
  e.target.closest?.('[data-task]')?.classList.remove('dragging')
  document.querySelectorAll('.column.drop').forEach(c => c.classList.remove('drop'))
})
document.addEventListener('dragover', e => {
  const col = e.target.closest?.('[data-drop]')
  if (!col || !dragged) return
  e.preventDefault()
  document.querySelectorAll('.column.drop').forEach(c => c !== col && c.classList.remove('drop'))
  col.classList.add('drop')
})
document.addEventListener('drop', e => {
  const col = e.target.closest?.('[data-drop]')
  if (!col || !dragged) return
  e.preventDefault()
  col.classList.remove('drop')
  const id = dragged
  dragged = undefined
  moveTask(id, col.dataset.drop)
})

let gPrefix = false
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette() }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && document.activeElement?.form) { e.preventDefault(); return document.activeElement.form.requestSubmit() }
  if (e.key === 'Tab') return trapFocus(e)
  if (e.key === 'Escape') {
    closeMenu()
    const hadDialog = document.getElementById('modal-root').innerHTML || document.getElementById('palette-root').innerHTML
    document.getElementById('modal-root').innerHTML = ''
    document.getElementById('palette-root').innerHTML = ''
    if (!hadDialog && closeTask()) return
    if (S.navOpen) { S.navOpen = false; render() }
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '/') { e.preventDefault(); return openPalette() }
  if (gPrefix) {
    gPrefix = false
    const map = { o: 'overview', t: 'tasks', a: 'agents', m: 'messages', c: 'activity', g: 'git', s: 'settings', p: 'projects', l: 'milestones' }
    if (map[e.key]) return go(map[e.key])
  }
  if (e.key === 'g') { gPrefix = true; setTimeout(() => (gPrefix = false), 900); return }
  if (e.key === 'n') { e.preventDefault(); return newTaskDialog() }
  const card = document.activeElement?.closest?.('[data-task]')
  if (card && e.key === 'Enter' && document.activeElement === card) return openTask(card.dataset.task, card)
  if (card && e.key === 'm') return openTaskMenu(card.dataset.task, card.querySelector('[data-menu]'))
})

// Live clocks without re-rendering.
setInterval(() => {
  const start = sessionStart()
  document.querySelectorAll('[data-tick="session"]').forEach(el => (el.textContent = clock(start === undefined ? undefined : Date.now() - start)))
  document.querySelectorAll('[data-tick="since"]').forEach(el => {
    const since = Number(el.dataset.since)
    if (since) el.textContent = duration(Date.now() - since)
  })
}, 1000)

// ------------------------------------------------------------------ boot

;(async () => {
  try {
    const fromHash = readHash()
    const { projects, current } = await api('/api/projects')
    S.projects = projects
    const wanted = fromHash || prefs.get('project', current)
    S.project = projects.some(p => p.slug === wanted) ? wanted : current
    writeHash()
    render()
    connectLive()
  } catch (error) {
    $root.innerHTML = `<div class="boot">Could not reach the dashboard server: ${esc(error.message)}</div>`
  }
})()
