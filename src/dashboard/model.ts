/**
 * The dashboard's view model, derived from a snapshot. Pure: the Claude Code
 * pane and the CLI's `wsc status` both draw from it.
 */
import { clockTime } from '../events/format.ts'
import type { Agent, GitCommit, Milestone, Request, Task, WorkspaceEvent, WorkspaceSnapshot } from '../types.ts'

export interface TaskCounts {
  completed: number
  ongoing: number
  pending: number
  blocked: number
  total: number
}

export interface WorkItem {
  id: string
  title: string
  owner: string
  status: Task['status']
  /** `68%`, `waiting`, `pending`, ... */
  progressLabel: string
  /** `12m`, `1h 04m`, or '' when the task has not started. */
  duration: string
}

export interface AgentRow {
  id: string
  status: Agent['status']
  task: string
  isSelf: boolean
  isOnline: boolean
}

export interface ActivityRow {
  time: string
  agent: string
  text: string
  type: WorkspaceEvent['type']
}

export interface DashboardModel {
  project: string
  counts: TaskCounts
  agents: AgentRow[]
  work: WorkItem[]
  activity: ActivityRow[]
  milestones: Milestone[]
  openRequests: Request[]
  inbox: number
  commits: GitCommit[]
}

export function parseTime(iso: string): number | undefined {
  if (!iso) return undefined
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T')
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? undefined : ms
}

/** 01:42:18 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

/** 4m, 1h 04m, 2d 3h */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function countTasks(tasks: readonly Task[]): TaskCounts {
  const counts: TaskCounts = { completed: 0, ongoing: 0, pending: 0, blocked: 0, total: tasks.length }
  for (const task of tasks) {
    if (task.status === 'DONE') counts.completed++
    else if (task.status === 'IN_PROGRESS' || task.status === 'REVIEW') counts.ongoing++
    else if (task.status === 'BLOCKED') counts.blocked++
    else counts.pending++
  }
  return counts
}

export function isAgentOnline(agent: Agent, now: number, staleMinutes: number): boolean {
  if (!agent.online) return false
  const last = parseTime(agent.lastActivity)
  return last === undefined || now - last < staleMinutes * 60_000
}

const STATUS_ORDER: Record<Task['status'], number> = { IN_PROGRESS: 0, REVIEW: 1, BLOCKED: 2, PENDING: 3, DONE: 4 }

function progressLabel(task: Task): string {
  if (task.status === 'IN_PROGRESS') return task.progress === undefined ? 'working' : `${task.progress}%`
  if (task.status === 'REVIEW') return 'review'
  if (task.status === 'BLOCKED') return 'blocked'
  if (task.status === 'DONE') return 'done'
  return task.owner ? 'claimed' : 'pending'
}

export function buildDashboard(
  snapshot: WorkspaceSnapshot,
  options: { now: number; self?: string; staleMinutes: number; commits?: readonly GitCommit[]; inboxIds?: readonly string[] },
): DashboardModel {
  const { now, self = '' } = options
  const work = snapshot.tasks
    .filter(t => t.status !== 'DONE')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id))
    .map(task => {
      const started = parseTime(task.started)
      return {
        id: task.id,
        title: task.title,
        owner: task.owner,
        status: task.status,
        progressLabel: progressLabel(task),
        duration: started === undefined ? '' : formatDuration(now - started),
      }
    })
  const agents = snapshot.agents
    .map(agent => ({
      id: agent.id,
      status: agent.status,
      task: agent.task,
      isSelf: agent.id === self,
      isOnline: isAgentOnline(agent, now, options.staleMinutes),
    }))
    .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.id.localeCompare(b.id))
  const activity = snapshot.events
    .slice(-8)
    .reverse()
    .map(e => ({ time: clockTime(e.timestamp), agent: e.agent, text: e.summary, type: e.type }))
  const openRequests = snapshot.requests.filter(r => r.status === 'OPEN')
  return {
    project: snapshot.project,
    counts: countTasks(snapshot.tasks),
    agents,
    work,
    activity,
    milestones: snapshot.milestones.slice(-3).reverse(),
    openRequests,
    inbox: options.inboxIds?.length ?? 0,
    commits: [...(options.commits ?? [])],
  }
}
