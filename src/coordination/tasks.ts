import { join } from 'node:path'

import { isAgentOnline } from '../dashboard/model.ts'
import { isoNow } from '../events/format.ts'
import { atomicWrite, readText } from '../filesystem/atomic.ts'
import { nextId, replaceSectionRaw, setFields, upsertSection } from '../obsidian/markdown.ts'
import { parseAgents, parseTasks, renderTask, toTaskStatus } from '../obsidian/records.ts'
import type { Identity, Workspace } from '../obsidian/workspace.ts'
import type { Task, TaskStatus } from '../types.ts'
import { updateAgent } from '../agents/agents.ts'
import { assertAgentId, escapeBody } from './validate.ts'
import { isOwnerActive } from './context.ts'

export class CoordinationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoordinationError'
  }
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return norm(a) === norm(b)
}

export function listTasks(ws: Workspace): Task[] {
  return parseTasks(readText(ws.path('tasks')))
}

function findTask(tasks: readonly Task[], id: string): Task {
  const task = tasks.find(t => t.id.toLowerCase() === id.toLowerCase())
  if (!task) throw new CoordinationError(`${id} does not exist in TASKS.md`)
  return task
}

export interface AddTaskResult {
  task: Task
  /** False when an open task with the same title already existed (dedupe). */
  created: boolean
}

/**
 * Adds a task. An open task with the same title is returned instead of a
 * duplicate, so two agents planning the same work converge on one record.
 */
export function addTask(
  ws: Workspace,
  identity: Identity,
  title: string,
  options: { depends?: string[]; notes?: string } = {},
): AddTaskResult {
  assertAgentId(identity.agent)
  const clean = title.replace(/\s+/g, ' ').trim()
  if (!clean) throw new CoordinationError('A task needs a title')
  let result: AddTaskResult | undefined
  const now = isoNow()
  ws.mutate('tasks', text => {
    const tasks = parseTasks(text)
    const existing = tasks.find(t => t.status !== 'DONE' && sameTitle(t.title, clean))
    if (existing) {
      result = { task: existing, created: false }
      return text
    }
    const task: Task = {
      id: nextId(text, 'TASK'),
      title: clean,
      status: 'PENDING',
      owner: '',
      depends: options.depends ?? [],
      created: now,
      updated: now,
      started: '',
      completed: '',
      notes: escapeBody(options.notes ?? ''),
    }
    result = { task, created: true }
    return upsertSection(text, task.id, renderTask(task))
  })
  if (result!.created) ws.emit(identity, 'TASK_CREATED', `created ${result!.task.id} ${clean}`, result!.task.id)
  return result!
}

export interface ClaimResult {
  task: Task
  /** Dependencies that are not DONE yet: the claim succeeds, with a warning. */
  unmetDependencies: string[]
  /** Previous owner when an offline agent's task was taken over. */
  tookOverFrom?: string
}

/**
 * Claims a task for this agent. Refused when another *online* agent owns it
 * (unless `force`), so two agents never unknowingly work on the same task.
 * A task whose owner went offline can be taken over.
 */
export function claimTask(ws: Workspace, identity: Identity, id: string, options: { force?: boolean } = {}): ClaimResult {
  assertAgentId(identity.agent)
  const stale = ws.resolved.config.staleAgentMinutes
  const now = isoNow()
  let result: ClaimResult | undefined
  ws.mutate('tasks', text => {
    const tasks = parseTasks(text)
    const task = findTask(tasks, id)
    if (task.status === 'DONE') throw new CoordinationError(`${task.id} is already DONE`)
    let tookOverFrom: string | undefined
    if (task.owner && task.owner.toLowerCase() !== identity.agent.toLowerCase()) {
      // Read AGENTS.md under the TASKS.md lock: a claim that landed just
      // before ours must be judged with its owner's current record.
      const owner = parseAgents(readText(ws.path('agents'))).find(a => a.id.toLowerCase() === task.owner.toLowerCase())
      const ownerOnline = isOwnerActive(owner, task, Date.now(), stale)
      if (ownerOnline && !options.force) {
        throw new CoordinationError(
          `${task.id} is owned by ${task.owner} (${owner?.status ?? 'online'}). ` +
            `Message them or request a handover; pass force only if they agreed.`,
        )
      }
      tookOverFrom = task.owner
    }
    const unmetDependencies = task.depends.filter(dep => {
      const d = tasks.find(t => t.id.toLowerCase() === dep.toLowerCase())
      return d !== undefined && d.status !== 'DONE'
    })
    const updated = replaceSectionRaw(text, task.id, raw =>
      setFields(raw, [
        { label: 'Status', value: 'IN_PROGRESS' },
        { label: 'Owner', value: identity.agent },
        { label: 'Updated', value: now },
        { label: 'Started', value: task.started || now },
      ]),
    )
    result = {
      task: { ...task, status: 'IN_PROGRESS', owner: identity.agent, updated: now, started: task.started || now },
      unmetDependencies,
      ...(tookOverFrom ? { tookOverFrom } : {}),
    }
    return updated ?? text
  })
  const { task } = result!
  updateAgent(ws, identity, { status: 'WORKING', task: `${task.id} ${task.title}`, workingState: `Working on ${task.id}` })
  const takeover = result!.tookOverFrom ? ` (taken over from ${result!.tookOverFrom})` : ''
  ws.emit(identity, 'TASK_CLAIMED', `claimed ${task.id} ${task.title}${takeover}`, task.id)
  return result!
}

export function releaseTask(ws: Workspace, identity: Identity, id: string, options: { force?: boolean; note?: string } = {}): Task {
  const now = isoNow()
  let released: Task | undefined
  ws.mutate('tasks', text => {
    const task = findTask(parseTasks(text), id)
    if (task.owner && task.owner.toLowerCase() !== identity.agent.toLowerCase() && !options.force) {
      throw new CoordinationError(`${task.id} is owned by ${task.owner}, not ${identity.agent}`)
    }
    const status: TaskStatus = task.status === 'DONE' ? 'DONE' : 'PENDING'
    released = { ...task, owner: '', status, updated: now }
    return (
      replaceSectionRaw(text, task.id, raw => {
        const next = setFields(raw, [
          { label: 'Status', value: status },
          { label: 'Owner', value: '-' },
          { label: 'Updated', value: now },
        ])
        return options.note ? `${next.trimEnd()}\n\n> Released by ${identity.agent}: ${escapeBody(options.note)}\n` : next
      }) ?? text
    )
  })
  updateAgent(ws, identity, { status: 'IDLE', task: '', workingState: `Released ${released!.id}` })
  ws.emit(identity, 'TASK_RELEASED', `released ${released!.id} ${released!.title}`, released!.id)
  return released!
}

const AGENT_STATUS_FOR_TASK: Partial<Record<TaskStatus, string>> = {
  IN_PROGRESS: 'WORKING',
  REVIEW: 'REVIEWING',
  BLOCKED: 'BLOCKED',
  DONE: 'COMPLETED',
}

/** Changes a task's status (and progress). DONE goes through `completeTask`. */
export function setTaskStatus(
  ws: Workspace,
  identity: Identity,
  id: string,
  statusInput: string,
  options: { progress?: number; note?: string; force?: boolean } = {},
): Task {
  const status = toTaskStatus(statusInput)
  if (status === 'DONE') return completeTask(ws, identity, id, options)
  const now = isoNow()
  let changed: Task | undefined
  ws.mutate('tasks', text => {
    const task = findTask(parseTasks(text), id)
    if (task.owner && task.owner.toLowerCase() !== identity.agent.toLowerCase() && !options.force) {
      throw new CoordinationError(`${task.id} is owned by ${task.owner}; claim it first`)
    }
    const owner = status === 'PENDING' ? task.owner : task.owner || identity.agent
    const progress = options.progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(options.progress)))
    changed = { ...task, status, owner, updated: now, ...(progress === undefined ? {} : { progress }) }
    return (
      replaceSectionRaw(text, task.id, raw => {
        const next = setFields(raw, [
          { label: 'Status', value: status },
          { label: 'Owner', value: owner || '-' },
          { label: 'Progress', value: progress === undefined ? undefined : `${progress}%` },
          { label: 'Updated', value: now },
          { label: 'Started', value: status === 'IN_PROGRESS' && !task.started ? now : undefined },
        ])
        return options.note ? `${next.trimEnd()}\n\n> ${identity.agent} (${status}): ${escapeBody(options.note)}\n` : next
      }) ?? text
    )
  })
  const task = changed!
  const agentStatus = AGENT_STATUS_FOR_TASK[status]
  if (agentStatus) updateAgent(ws, identity, { status: agentStatus, task: `${task.id} ${task.title}` })
  const progress = task.progress === undefined || options.progress === undefined ? '' : ` (${task.progress}%)`
  ws.emit(identity, 'TASK_STATUS', `set ${task.id} to ${status}${progress}${options.note ? ` — ${options.note}` : ''}`, task.id)
  return task
}

export function completeTask(ws: Workspace, identity: Identity, id: string, options: { note?: string; force?: boolean } = {}): Task {
  const now = isoNow()
  let done: Task | undefined
  ws.mutate('tasks', text => {
    const task = findTask(parseTasks(text), id)
    if (task.owner && task.owner.toLowerCase() !== identity.agent.toLowerCase() && !options.force) {
      throw new CoordinationError(`${task.id} is owned by ${task.owner}; only the owner completes it`)
    }
    done = { ...task, status: 'DONE', owner: task.owner || identity.agent, progress: 100, completed: now, updated: now }
    return (
      replaceSectionRaw(text, task.id, raw => {
        const next = setFields(raw, [
          { label: 'Status', value: 'DONE' },
          { label: 'Owner', value: done!.owner },
          { label: 'Progress', value: '100%' },
          { label: 'Updated', value: now },
          { label: 'Completed', value: now },
        ])
        return options.note ? `${next.trimEnd()}\n\n> Completed by ${identity.agent}: ${escapeBody(options.note)}\n` : next
      }) ?? text
    )
  })
  syncPlanCheckbox(ws, done!.id, true)
  updateAgent(ws, identity, { status: 'COMPLETED', task: '', workingState: `Completed ${done!.id}` })
  ws.emit(identity, 'TASK_COMPLETED', `completed ${done!.id} ${done!.title}`, done!.id)
  return done!
}

/** Ticks or unticks `- [ ] TASK-004 ...` lines in PLAN.md. */
export function syncPlanCheckbox(ws: Workspace, id: string, done: boolean): void {
  const pattern = new RegExp(`^(\\s*[-*] \\[)[ xX](\\]\\s+(?:\\*\\*)?${id}\\b)`, 'gm')
  ws.mutate('plan', text => text.replace(pattern, `$1${done ? 'x' : ' '}$2`))
}

export interface PlanInput {
  objective: string
  tasks: string[]
  /** `Claude-01=Backend` pairs. */
  assignments?: string[]
  dependencies?: string[]
  notes?: string
}

export interface PlanResult {
  path: string
  tasks: Task[]
  archived?: string
}

/**
 * Writes PLAN.md and creates one task per plan item (deduplicated by title).
 * A previous plan is archived under PLANS/ first, never silently lost.
 */
export function createPlan(ws: Workspace, identity: Identity, input: PlanInput): PlanResult {
  if (!input.objective.trim()) throw new CoordinationError('A plan needs an objective')
  const tasks = input.tasks.map(title => addTask(ws, identity, title).task)
  const now = isoNow()
  let archived: string | undefined
  ws.mutate('plan', current => {
    if (current.trim() && !/No plan yet\./.test(current)) {
      archived = join(ws.root, 'PLANS', `PLAN-${now.replace(/[:]/g, '').replace(/\+.*/, '')}.md`)
      atomicWrite(archived, current)
    }
    const lines = [
      `# Current Plan · ${ws.project}`,
      '',
      `<!-- WC_PLAN author: ${identity.agent} session: ${identity.session} created: ${now} -->`,
      '',
      '## Objective',
      '',
      input.objective.trim(),
      '',
      '## Tasks',
      '',
      ...tasks.map(t => `- [${t.status === 'DONE' ? 'x' : ' '}] ${t.id} ${t.title}`),
      '',
      '## Agents',
      '',
      ...(input.assignments?.length
        ? input.assignments.map(a => {
            const [agent, area] = a.split('=')
            return `- ${(agent ?? '').trim()} → ${(area ?? '').trim() || 'unassigned'}`
          })
        : ['- unassigned']),
      '',
      '## Dependencies',
      '',
      ...(input.dependencies?.length ? input.dependencies.map(d => `- ${d}`) : ['- none']),
      '',
    ]
    if (input.notes?.trim()) lines.push('## Notes', '', input.notes.trim(), '')
    return lines.join('\n')
  })
  ws.emit(identity, 'PLAN_CREATED', `created plan: ${input.objective.trim().split('\n')[0]}`, 'PLAN')
  return { path: ws.path('plan'), tasks, ...(archived ? { archived } : {}) }
}
