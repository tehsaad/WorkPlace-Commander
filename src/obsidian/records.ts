/**
 * Typed parse/render of each record file. Pure: shared by CLI and hooks module.
 */
import { AGENT_STATUSES, PRIORITIES, REQUEST_STATUSES, TASK_STATUSES } from '../types.ts'
import type {
  Agent,
  AgentStatus,
  CommitRecord,
  Message,
  Milestone,
  Priority,
  Request,
  RequestAnswer,
  RequestStatus,
  Task,
  TaskStatus,
} from '../types.ts'
import { humanTime } from '../events/format.ts'
import { unescapeBody } from '../coordination/validate.ts'
import { normalizeWord, parseFields, renderSection, splitList, splitSections } from './markdown.ts'

// ---------------------------------------------------------------- statuses

const TASK_SYNONYMS: Record<string, TaskStatus> = {
  TODO: 'PENDING',
  OPEN: 'PENDING',
  NEW: 'PENDING',
  UNCLAIMED: 'PENDING',
  CLAIMED: 'IN_PROGRESS',
  WORKING: 'IN_PROGRESS',
  ONGOING: 'IN_PROGRESS',
  INPROGRESS: 'IN_PROGRESS',
  REVIEWING: 'REVIEW',
  IN_REVIEW: 'REVIEW',
  WAITING: 'BLOCKED',
  COMPLETE: 'DONE',
  COMPLETED: 'DONE',
  FINISHED: 'DONE',
  CLOSED: 'DONE',
}

export function toTaskStatus(value: string | undefined): TaskStatus {
  const word = normalizeWord(value ?? '')
  if ((TASK_STATUSES as readonly string[]).includes(word)) return word as TaskStatus
  return TASK_SYNONYMS[word] ?? 'PENDING'
}

export function toAgentStatus(value: string | undefined): AgentStatus {
  const word = normalizeWord(value ?? '')
  if ((AGENT_STATUSES as readonly string[]).includes(word)) return word as AgentStatus
  if (word === 'REVIEW') return 'REVIEWING'
  if (word === 'DONE') return 'COMPLETED'
  if (word === 'IN_PROGRESS') return 'WORKING'
  return 'IDLE'
}

export function toRequestStatus(value: string | undefined): RequestStatus {
  const word = normalizeWord(value ?? '')
  if ((REQUEST_STATUSES as readonly string[]).includes(word)) return word as RequestStatus
  if (word === 'RESOLVED' || word === 'DONE') return 'CLOSED'
  return 'OPEN'
}

export function toPriority(value: string | undefined): Priority {
  const word = normalizeWord(value ?? '')
  if ((PRIORITIES as readonly string[]).includes(word)) return word as Priority
  if (word === 'MEDIUM') return 'NORMAL'
  if (word === 'CRITICAL') return 'URGENT'
  return 'NORMAL'
}

function isYes(value: string | undefined): boolean {
  return /^(yes|true|online|1)$/i.test((value ?? '').trim())
}

function orDash(value: string): string {
  return value.trim() === '' ? '-' : value
}

/** Removes WC_EVENT metadata blocks (they precede the next heading) from a body. */
function stripEvents(body: string): string {
  return body.replace(/<!--\s*WC_EVENT[\s\S]*?-->/g, '').trim()
}

/** The body for display: event blocks removed, escaped headings restored. */
function cleanBody(body: string): string {
  return unescapeBody(stripEvents(body))
}

function fromDash(value: string | undefined): string {
  const v = (value ?? '').trim()
  return v === '-' ? '' : v
}

// ---------------------------------------------------------------- agents

const AGENT_FIELDS = ['status', 'task', 'branch', 'session', 'kind', 'capabilities', 'process', 'started', 'last activity', 'working state', 'online']

export function parseAgents(text: string): Agent[] {
  return splitSections(text)
    .sections.filter(s => s.id !== '' && !/\s/.test(s.id))
    .map(s => {
      const { fields } = parseFields(s.raw, AGENT_FIELDS)
      return {
        id: s.id,
        status: toAgentStatus(fields.status),
        task: fromDash(fields.task),
        branch: fromDash(fields.branch),
        session: fromDash(fields.session),
        kind: fromDash(fields.kind) || 'unknown',
        started: fromDash(fields.started),
        lastActivity: fromDash(fields.lastactivity),
        workingState: fromDash(fields.workingstate),
        online: fields.online === undefined ? true : isYes(fields.online),
        ...(splitList(fromDash(fields.capabilities)).length ? { capabilities: splitList(fromDash(fields.capabilities)) } : {}),
        ...(fromDash(fields.process) ? { process: fromDash(fields.process) } : {}),
      }
    })
}

export function renderAgent(agent: Agent): string {
  return renderSection(agent.id, [
    { label: 'Status', value: agent.status },
    { label: 'Task', value: orDash(agent.task) },
    { label: 'Branch', value: orDash(agent.branch) },
    { label: 'Session', value: orDash(agent.session) },
    { label: 'Kind', value: agent.kind },
    { label: 'Capabilities', value: agent.capabilities?.length ? agent.capabilities.join(', ') : undefined },
    { label: 'Process', value: agent.process || undefined },
    { label: 'Started', value: orDash(agent.started) },
    { label: 'Last Activity', value: orDash(agent.lastActivity) },
    { label: 'Working State', value: orDash(agent.workingState) },
    { label: 'Online', value: agent.online ? 'yes' : 'no' },
  ])
}

// ---------------------------------------------------------------- tasks

const TASK_FIELDS = ['status', 'owner', 'progress', 'depends', 'created', 'updated', 'started', 'completed']
export const TASK_ID = /^TASK-\d+$/i

export function parseTasks(text: string): Task[] {
  return splitSections(text)
    .sections.filter(s => TASK_ID.test(s.id))
    .map(s => {
      const { fields, body } = parseFields(s.raw, TASK_FIELDS)
      const progressMatch = /(\d{1,3})/.exec(fields.progress ?? '')
      const progress = progressMatch ? Math.min(100, Number(progressMatch[1])) : undefined
      return {
        id: s.id.toUpperCase(),
        title: s.title || s.id,
        status: toTaskStatus(fields.status),
        owner: fromDash(fields.owner),
        ...(progress === undefined ? {} : { progress }),
        depends: splitList(fromDash(fields.depends)),
        created: fromDash(fields.created),
        updated: fromDash(fields.updated),
        started: fromDash(fields.started),
        completed: fromDash(fields.completed),
        notes: cleanBody(body),
      }
    })
}

export function renderTask(task: Task): string {
  return renderSection(
    `${task.id} · ${task.title}`,
    [
      { label: 'Status', value: task.status },
      { label: 'Owner', value: orDash(task.owner) },
      { label: 'Progress', value: task.progress === undefined ? undefined : `${task.progress}%` },
      { label: 'Depends', value: task.depends.length ? task.depends.join(', ') : undefined },
      { label: 'Created', value: orDash(task.created) },
      { label: 'Updated', value: orDash(task.updated) },
      { label: 'Started', value: task.started || undefined },
      { label: 'Completed', value: task.completed || undefined },
    ],
    task.notes,
  )
}

// ---------------------------------------------------------------- requests

const REQUEST_FIELDS = ['status', 'from', 'requester', 'to', 'recipient', 'requested from', 'priority', 'created', 'updated']
export const REQUEST_ID = /^REQUEST-\d+$/i

function splitSubsections(body: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = []
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] }
  for (const line of body.split('\n')) {
    const match = /^###\s+(.*)$/.exec(line)
    if (match) {
      out.push({ heading: current.heading, text: current.lines.join('\n').trim() })
      current = { heading: (match[1] ?? '').trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  out.push({ heading: current.heading, text: current.lines.join('\n').trim() })
  return out
}

/** `Answer — Antigravity-01 · 2026-10-08 19:50` -> agent and time. */
function parseAnswerHeading(heading: string): { agent: string; timestamp: string } {
  const rest = heading.replace(/^(answer|response|reply)\b\s*/i, '')
  const parts = rest
    .split(/\s*(?:·|—|–|\||\bby\b|\bfrom\b|\bat\b)\s*/i)
    .map(p => p.trim())
    .filter(Boolean)
  const timestamp = parts.find(p => /\d{4}-\d{2}-\d{2}/.test(p)) ?? ''
  const agent = parts.find(p => p !== timestamp && !/^-+$/.test(p)) ?? 'unknown'
  return { agent, timestamp }
}

export function parseRequests(text: string): Request[] {
  return splitSections(text)
    .sections.filter(s => REQUEST_ID.test(s.id))
    .map(s => {
      const { fields, body } = parseFields(s.raw, REQUEST_FIELDS)
      // Split before unescaping: an escaped `\### Answer` inside a body is text, not an answer.
      const subs = splitSubsections(stripEvents(body)).map(sub => ({ ...sub, text: unescapeBody(sub.text) }))
      const answers: RequestAnswer[] = []
      let question = ''
      for (const sub of subs) {
        if (/^(answer|response|reply)\b/i.test(sub.heading)) {
          answers.push({ ...parseAnswerHeading(sub.heading), body: sub.text })
        } else if (sub.heading === '' || /^question\b/i.test(sub.heading)) {
          question = [question, sub.text].filter(Boolean).join('\n\n')
        }
      }
      // An answer appended without the heading convention still counts when
      // the author flipped the status: keep the protocol forgiving.
      let status = toRequestStatus(fields.status)
      if (answers.length > 0 && status === 'OPEN') status = 'ANSWERED'
      return {
        id: s.id.toUpperCase(),
        title: s.title || s.id,
        status,
        from: fromDash(fields.from ?? fields.requester),
        to: fromDash(fields.to ?? fields.recipient ?? fields.requestedfrom),
        priority: toPriority(fields.priority),
        created: fromDash(fields.created),
        updated: fromDash(fields.updated),
        question,
        answers,
      }
    })
}

export function renderAnswer(answer: RequestAnswer): string {
  return `### Answer — ${answer.agent} · ${humanTime(answer.timestamp)}\n\n${answer.body.trim()}\n`
}

export function renderRequest(request: Request): string {
  const body = [`### Question\n\n${request.question.trim()}`, ...request.answers.map(renderAnswer)].join('\n\n')
  return renderSection(
    `${request.id} · ${request.title}`,
    [
      { label: 'Status', value: request.status },
      { label: 'From', value: request.from },
      { label: 'To', value: request.to },
      { label: 'Priority', value: request.priority },
      { label: 'Created', value: request.created },
      { label: 'Updated', value: request.updated },
    ],
    body,
  )
}

// ---------------------------------------------------------------- messages

const MESSAGE_FIELDS = ['from', 'to', 'time', 'timestamp', 'date']
export const MESSAGE_ID = /^MSG-\d+$/i

export function parseMessages(text: string): Message[] {
  return splitSections(text)
    .sections.filter(s => MESSAGE_ID.test(s.id))
    .map(s => {
      const { fields, body } = parseFields(s.raw, MESSAGE_FIELDS)
      return {
        id: s.id.toUpperCase(),
        from: fields.from ?? 'unknown',
        to: fields.to ?? 'ALL',
        timestamp: fields.time ?? fields.timestamp ?? fields.date ?? '',
        body: cleanBody(body),
      }
    })
}

export function renderMessage(message: Message): string {
  return (
    `## ${message.id} · ${message.from} → ${message.to}\n` +
    `FROM: ${message.from}\nTO: ${message.to}\nTIME: ${message.timestamp}\n\n${message.body.trim()}\n`
  )
}

// ---------------------------------------------------------------- milestones

const MILESTONE_FIELDS = ['agent', 'time', 'timestamp']
export const MILESTONE_ID = /^MILESTONE-\d+$/i

export function parseMilestones(text: string): Milestone[] {
  return splitSections(text)
    .sections.filter(s => MILESTONE_ID.test(s.id))
    .map(s => {
      const { fields, body } = parseFields(s.raw, MILESTONE_FIELDS)
      return {
        id: s.id.toUpperCase(),
        title: s.title || s.id,
        agent: fields.agent ?? 'unknown',
        timestamp: fields.time ?? fields.timestamp ?? '',
        note: cleanBody(body),
      }
    })
}

export function renderMilestone(milestone: Milestone): string {
  return renderSection(
    `${milestone.id} · ${milestone.title}`,
    [
      { label: 'Agent', value: milestone.agent },
      { label: 'Time', value: milestone.timestamp },
    ],
    milestone.note,
  )
}

// ---------------------------------------------------------------- commits

const COMMIT_LINE = /^- `([0-9a-f]{4,40})` (.*?) · ([^·]+?) · ([^·]+?) · (.+)$/

export function parseCommits(text: string): CommitRecord[] {
  const out: CommitRecord[] = []
  for (const line of text.split('\n')) {
    const m = COMMIT_LINE.exec(line.trim())
    if (m) {
      out.push({
        hash: m[1] ?? '',
        subject: m[2] ?? '',
        agent: (m[3] ?? '').trim(),
        branch: (m[4] ?? '').trim(),
        timestamp: (m[5] ?? '').trim(),
      })
    }
  }
  return out
}

export function renderCommit(commit: CommitRecord): string {
  const subject = commit.subject.replace(/·/g, '-')
  return `- \`${commit.hash}\` ${subject} · ${commit.agent} · ${commit.branch || '-'} · ${commit.timestamp}`
}
