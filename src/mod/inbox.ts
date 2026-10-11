/**
 * Detects what is new for this agent between two reads of the workspace:
 * messages addressed to it, requests addressed to it, and answers to its own
 * requests. Pure, so it is unit-testable outside the host.
 */
import { isAgentOnline } from '../dashboard/model.ts'
import type { WcSelf, WcSnapshot } from '../../types'

export interface Seen {
  /** Highest MSG number already seen. */
  message: number
  /** Request ids addressed to this agent already seen. */
  requests: string[]
  /** For this agent's own requests: how many answers were already seen. */
  answers: Record<string, number>
}

/** Nothing seen yet: a new agent id's first session reads what is already addressed to it. */
export const EMPTY_SEEN: Seen = { message: 0, requests: [], answers: {} }

/** At most this many messages are quoted at once; the rest are counted and pointed to. */
const MAX_MESSAGES = 10

export interface InboxItem {
  kind: 'message' | 'request' | 'answer' | 'task'
  id: string
  from: string
  /** True when addressed to this agent by id (not a broadcast): worth waking for. */
  isDirect: boolean
  text: string
}

const num = (id: string) => Number(/\d+/.exec(id)?.[0] ?? 0)
const isMe = (value: string, me: string) => value.trim().toLowerCase() === me.toLowerCase()
const isAll = (value: string) => value.trim().toUpperCase() === 'ALL'

function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The seen-marker for everything currently in the snapshot. */
export function seenAll(snapshot: WcSnapshot, me: string): Seen {
  return {
    message: Math.max(0, ...snapshot.messages.map(m => num(m.id))),
    requests: snapshot.requests.filter(r => isMe(r.to, me) || isAll(r.to)).map(r => r.id),
    answers: Object.fromEntries(snapshot.requests.filter(r => isMe(r.from, me)).map(r => [r.id, r.answers.length])),
  }
}

export function diffInbox(snapshot: WcSnapshot, me: string, seen: Seen): { items: InboxItem[]; seen: Seen } {
  const items: InboxItem[] = []
  for (const m of snapshot.messages) {
    if (num(m.id) <= seen.message || isMe(m.from, me)) continue
    if (!isMe(m.to, me) && !isAll(m.to)) continue
    items.push({ kind: 'message', id: m.id, from: m.from, isDirect: isMe(m.to, me), text: `${m.id} from ${m.from}:\n${clip(m.body)}` })
  }
  for (const r of snapshot.requests) {
    if (isMe(r.from, me)) {
      const known = seen.answers[r.id] ?? 0
      for (const answer of r.answers.slice(known)) {
        items.push({
          kind: 'answer',
          id: r.id,
          from: answer.agent,
          isDirect: true,
          text: `${r.id} (“${r.title}”) answered by ${answer.agent}:\n${clip(answer.body)}`,
        })
      }
    } else if ((isMe(r.to, me) || isAll(r.to)) && r.status === 'OPEN' && !seen.requests.includes(r.id)) {
      items.push({
        kind: 'request',
        id: r.id,
        from: r.from,
        isDirect: isMe(r.to, me),
        text: `${r.id} from ${r.from} (${r.priority}): ${r.title}\n${clip(r.question)}`,
      })
    }
  }
  return { items, seen: seenAll(snapshot, me) }
}

/** Identity of an inbox item, to queue each one once across refreshes. */
export function itemKey(item: InboxItem): string {
  return `${item.kind}:${item.id}:${item.from}:${item.text.length}`
}

/**
 * Tasks this agent owned in `before` that another agent now owns, or that
 * were reset: worth telling the agent, so it stops working on them.
 */
export function diffTasks(before: WcSnapshot | null, after: WcSnapshot, me: string): InboxItem[] {
  if (!before) return []
  const items: InboxItem[] = []
  for (const was of before.tasks) {
    if (!isMe(was.owner, me) || was.status === 'DONE') continue
    const now = after.tasks.find(t => t.id === was.id)
    if (!now || isMe(now.owner, me)) continue
    const by = now.owner && now.owner !== '-' ? now.owner : 'someone'
    items.push({
      kind: 'task',
      id: was.id,
      from: by,
      isDirect: true,
      text: `${was.id} (“${was.title}”) is no longer yours: owner ${now.owner || '-'}, status ${now.status}. Stop working on it unless you agree a handover with ${by}.`,
    })
  }
  return items
}

/** Messages beyond MAX_MESSAGES are counted, never dropped silently. */
function capMessages(items: readonly InboxItem[], file: string): { shown: InboxItem[]; note: string } {
  const messages = items.filter(i => i.kind === 'message')
  if (messages.length <= MAX_MESSAGES) return { shown: [...items], note: '' }
  const hidden = new Set(messages.slice(0, messages.length - MAX_MESSAGES))
  return {
    shown: items.filter(i => !hidden.has(i)),
    note: `${hidden.size} earlier unread messages (${[...hidden][0]!.id} to ${[...hidden].at(-1)!.id}) are not quoted here: read them in ${file}.`,
  }
}

function itemLines(items: readonly InboxItem[], messagesFile: string): string[] {
  const { shown, note } = capMessages(items, messagesFile)
  const lines: string[] = []
  for (const item of shown) lines.push('', `• ${item.text}`)
  if (note) lines.push('', note)
  return lines
}

/** The text handed to the model: as prompt context, or as a wake-up prompt. */
export function formatInbox(items: readonly InboxItem[], me: string, messagesFile = 'MESSAGES.md'): string {
  const lines = [`[Workspace Commander] New in the shared workspace for ${me}:`, ...itemLines(items, messagesFile)]
  lines.push(
    '',
    'Answer requests addressed to you with request_answer, reply to messages with message_send, and use answers to your requests to continue your work.',
  )
  return lines.join('\n')
}

/**
 * What a session learns on startup: who it is, who else is online, the open
 * tasks, open requests for it, and its unread items. Given once, with the
 * first prompt, so a new session starts with the shared state in context.
 */
export function formatBriefing(
  self: Pick<WcSelf, 'agentId' | 'session' | 'project' | 'workspace' | 'files' | 'staleMinutes'>,
  snapshot: WcSnapshot,
  unread: readonly InboxItem[],
  now: number,
): string {
  const me = self.agentId
  const online = snapshot.agents.filter(a => !isMe(a.id, me) && isAgentOnline(a, now, self.staleMinutes))
  const open = snapshot.tasks.filter(t => t.status !== 'DONE')
  const requests = snapshot.requests.filter(r => r.status === 'OPEN' && (isMe(r.to, me) || isAll(r.to)) && !isMe(r.from, me))
  const mine = snapshot.requests.filter(r => isMe(r.from, me) && r.status !== 'CLOSED')
  const lines = [
    `[Workspace Commander] Session briefing for ${me} (session ${self.session}), project "${self.project}".`,
    `Workspace: ${self.workspace} · protocol: ${self.workspace}/${self.files.protocol}`,
    '',
    `Agents online: ${online.length ? online.map(a => `${a.id} ${a.status}${a.task ? ` on ${a.task}` : ''}`).join('; ') : 'none besides you'}`,
  ]
  lines.push('', open.length ? `Open tasks (${open.length}):` : 'Open tasks: none.')
  for (const t of open.slice(0, 20)) {
    lines.push(`- ${t.id} ${t.status}${t.owner && t.owner !== '-' ? ` · ${t.owner}` : ' · unowned'}: ${t.title}`)
  }
  if (open.length > 20) lines.push(`- … ${open.length - 20} more in ${self.files.tasks}`)
  lines.push('', requests.length ? 'Open requests for you:' : 'Open requests for you: none.')
  for (const r of requests) lines.push(`- ${r.id} from ${r.from} (${r.priority}) to ${r.to}: ${r.title}`)
  if (mine.length) lines.push('', `Your own requests still open: ${mine.map(r => `${r.id} ${r.status}`).join(', ')}`)
  const rest = unread.filter(i => i.kind !== 'request')
  if (rest.length) lines.push('', 'Unread for you:', ...itemLines(rest, self.files.messages))
  lines.push(
    '',
    'Call workspace_status for the live board. Claim a task with task_claim before working on it.',
  )
  return lines.join('\n')
}
