/**
 * What one agent needs to know at the start of a turn, built from a snapshot.
 * Pure: shared by `wsc context`, the MCP server and the dashboard.
 *
 * It is the briefing for tools without lifecycle hooks: they call it (the
 * `workspace_status` MCP tool, or `wsc context`) instead of being briefed.
 */
import { isAgentOnline } from '../dashboard/model.ts'
import type { Agent, Message, Request, Task, WorkspaceSnapshot } from '../types.ts'

/**
 * Whether a task's owner still counts as working on it. An owner with an
 * AGENTS.md record is active while that record is online. An owner without
 * one (an agent using the CLI ad hoc, or one whose record is still being
 * written) is active while the task itself was updated recently: otherwise a
 * claim made milliseconds ago could be "taken over" as if abandoned.
 */
export function isOwnerActive(owner: Agent | undefined, task: Task, now: number, staleMinutes: number): boolean {
  if (owner) return isAgentOnline(owner, now, staleMinutes)
  const updated = Date.parse(task.updated)
  return Number.isNaN(updated) ? false : now - updated < staleMinutes * 60_000
}

export interface AgentContext {
  agent: string
  project: string
  workspace: string
  objective: string
  /** Tasks this agent owns that are not DONE: what to resume after a restart. */
  yourTasks: Task[]
  /** Unowned PENDING tasks. */
  availableTasks: Task[]
  /** Open tasks whose owner went offline: can be taken over with `task claim`. */
  recoverableTasks: Task[]
  agentsOnline: Agent[]
  /** Messages to this agent or ALL, from others, newer than `readUpTo`. */
  inbox: Message[]
  /** OPEN requests addressed to this agent (or ALL) by others. */
  requestsForYou: Request[]
  /** This agent's own requests that have answers and are not closed. */
  answersForYou: Request[]
  /** The highest message number already delivered to this agent. */
  readUpTo: number
}

const num = (id: string): number => Number(/\d+/.exec(id)?.[0] ?? 0)
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The objective paragraph of PLAN.md, or ''. */
export function planObjective(plan: string): string {
  const match = /^##\s+Objective\s*\n+([\s\S]*?)(?=\n##\s|$)/m.exec(plan)
  return (match?.[1] ?? '').trim()
}

export function buildContext(
  snapshot: WorkspaceSnapshot,
  agent: string,
  options: { now: number; staleMinutes: number; readUpTo?: number },
): AgentContext {
  const { now, staleMinutes } = options
  const readUpTo = options.readUpTo ?? 0
  const byId = new Map(snapshot.agents.map(a => [a.id.toLowerCase(), a]))
  const open = snapshot.tasks.filter(t => t.status !== 'DONE')
  return {
    agent,
    project: snapshot.project,
    workspace: snapshot.workspace,
    objective: planObjective(snapshot.plan),
    yourTasks: open.filter(t => same(t.owner, agent)),
    availableTasks: open.filter(t => !t.owner && t.status === 'PENDING'),
    recoverableTasks: open.filter(
      t => t.owner && !same(t.owner, agent) && !isOwnerActive(byId.get(t.owner.toLowerCase()), t, now, staleMinutes),
    ),
    agentsOnline: snapshot.agents.filter(a => isAgentOnline(a, now, staleMinutes)),
    inbox: snapshot.messages.filter(
      m => num(m.id) > readUpTo && !same(m.from, agent) && (same(m.to, agent) || m.to.toUpperCase() === 'ALL'),
    ),
    requestsForYou: snapshot.requests.filter(
      r => r.status === 'OPEN' && !same(r.from, agent) && (same(r.to, agent) || r.to.toUpperCase() === 'ALL'),
    ),
    answersForYou: snapshot.requests.filter(r => same(r.from, agent) && r.status === 'ANSWERED' && r.answers.length > 0),
    readUpTo,
  }
}

/** The highest message number in `context.inbox` (what to mark as read). */
export function lastInboxNumber(context: AgentContext): number {
  return context.inbox.reduce((max, m) => Math.max(max, num(m.id)), context.readUpTo)
}

const flat = (text: string, max = 300): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function formatContext(context: AgentContext): string {
  const task = (t: Task) => `${t.id} ${t.title} [${t.status}${t.progress === undefined ? '' : ` ${t.progress}%`}]${t.owner ? ` · ${t.owner}` : ''}`
  const lines = [
    `You are ${context.agent} in project "${context.project}". Workspace: ${context.workspace}`,
    context.objective ? `Objective: ${flat(context.objective, 400)}` : 'No plan yet (plan_create writes one).',
    '',
    `Your open tasks (${context.yourTasks.length})${context.yourTasks.length ? ', resume these first:' : ':'}`,
    ...(context.yourTasks.length ? context.yourTasks.map(t => `- ${task(t)}`) : ['- none']),
    `Available tasks (${context.availableTasks.length}):`,
    ...(context.availableTasks.length ? context.availableTasks.map(t => `- ${task(t)}`) : ['- none']),
  ]
  if (context.recoverableTasks.length) {
    lines.push(
      `Owner offline, can be taken over with task_claim (${context.recoverableTasks.length}):`,
      ...context.recoverableTasks.map(t => `- ${task(t)}`),
    )
  }
  lines.push(
    `Agents online: ${context.agentsOnline.length ? context.agentsOnline.map(a => `${a.id} (${a.kind}, ${a.status}${a.task ? `: ${flat(a.task, 60)}` : ''})`).join(', ') : 'none'}`,
    '',
    `Unread messages (${context.inbox.length}):`,
    ...(context.inbox.length ? context.inbox.map(m => `- ${m.id} from ${m.from} to ${m.to}: ${flat(m.body)}`) : ['- none']),
    `Requests waiting for your answer (${context.requestsForYou.length}):`,
    ...(context.requestsForYou.length
      ? context.requestsForYou.map(r => `- ${r.id} from ${r.from} (${r.priority}): ${flat(r.question)}`)
      : ['- none']),
  )
  if (context.answersForYou.length) {
    lines.push(
      `Answers to your requests (${context.answersForYou.length}; close them with request_close when done):`,
      ...context.answersForYou.map(r => {
        const last = r.answers.at(-1)
        return `- ${r.id} ${flat(r.title, 80)}: ${last ? `${last.agent}: ${flat(last.body)}` : ''}`
      }),
    )
  }
  return lines.join('\n')
}
