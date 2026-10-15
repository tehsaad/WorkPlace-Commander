import { formatEventMeta, isoNow, newEventId } from '../events/format.ts'
import { readText } from '../filesystem/atomic.ts'
import { nextId, replaceSectionRaw, setFields, upsertSection } from '../obsidian/markdown.ts'
import {
  parseMessages,
  parseMilestones,
  parseRequests,
  renderAnswer,
  renderMessage,
  renderMilestone,
  renderRequest,
  toPriority,
} from '../obsidian/records.ts'
import type { Identity, Workspace } from '../obsidian/workspace.ts'
import type { Message, Milestone, Request, WorkspaceEventType } from '../types.ts'
import { CoordinationError } from './tasks.ts'
import { assertAgentId, assertRecipient, escapeBody, oneLineText, unescapeBody } from './validate.ts'

function meta(identity: Identity, type: WorkspaceEventType, timestamp: string, ref: string): string {
  return formatEventMeta({ id: newEventId(), type, agent: identity.agent, session: identity.session, timestamp, ref, summary: '' })
}

function preview(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

// ---------------------------------------------------------------- messages

/** Appends a message to MESSAGES.md. `to` is an agent id or ALL. */
export function sendMessage(ws: Workspace, identity: Identity, to: string, body: string): Message {
  assertAgentId(identity.agent)
  if (!body.trim()) throw new CoordinationError('A message needs a body')
  const recipient = assertRecipient(to.trim() || 'ALL')
  const timestamp = isoNow()
  let message: Message | undefined
  ws.appendRecord('messages', current => {
    message = { id: nextId(current, 'MSG'), from: identity.agent, to: recipient, timestamp, body: escapeBody(body.trim()) }
    return `${meta(identity, 'MESSAGE_SENT', timestamp, message.id)}\n${renderMessage(message)}`
  })
  ws.emit(identity, 'MESSAGE_SENT', `messaged ${message!.to}: ${preview(body, 60)}`, message!.id)
  return { ...message!, body: unescapeBody(message!.body) }
}

export function listMessages(ws: Workspace): Message[] {
  return parseMessages(readText(ws.path('messages')))
}

/** Messages addressed to `agent` (or ALL) after `afterId`, excluding its own. */
export function inbox(messages: readonly Message[], agent: string, afterId?: string): Message[] {
  const after = afterId ? Number(/\d+/.exec(afterId)?.[0] ?? 0) : 0
  return messages.filter(
    m =>
      Number(/\d+/.exec(m.id)?.[0] ?? 0) > after &&
      m.from.toLowerCase() !== agent.toLowerCase() &&
      (m.to.toLowerCase() === agent.toLowerCase() || m.to.toUpperCase() === 'ALL'),
  )
}

// ---------------------------------------------------------------- requests

export function listRequests(ws: Workspace): Request[] {
  return parseRequests(readText(ws.path('requests')))
}

export function createRequest(
  ws: Workspace,
  identity: Identity,
  input: { to: string; question: string; title?: string; priority?: string },
): Request {
  assertAgentId(identity.agent)
  if (!input.question.trim()) throw new CoordinationError('A request needs a question')
  if (!input.to.trim()) throw new CoordinationError('A request needs a recipient (agent id or ALL)')
  const to = assertRecipient(input.to)
  const now = isoNow()
  let request: Request | undefined
  ws.mutate('requests', text => {
    request = {
      id: nextId(text, 'REQUEST'),
      title: oneLineText(input.title?.trim() || preview(input.question, 60), 200),
      status: 'OPEN',
      from: identity.agent,
      to,
      priority: toPriority(input.priority),
      created: now,
      updated: now,
      question: escapeBody(input.question.trim()),
      answers: [],
    }
    return upsertSection(text, request.id, renderRequest(request))
  })
  ws.emit(identity, 'REQUEST_CREATED', `asked ${request!.to} ${request!.id} (${request!.priority}): ${request!.title}`, request!.id)
  return request!
}

/**
 * Appends an answer to a request and marks it ANSWERED (or CLOSED). The
 * section is edited in place: every other line is preserved.
 */
export function answerRequest(
  ws: Workspace,
  identity: Identity,
  id: string,
  body: string,
  options: { close?: boolean } = {},
): Request {
  assertAgentId(identity.agent)
  if (!body.trim()) throw new CoordinationError('An answer needs a body')
  const now = isoNow()
  const status = options.close ? 'CLOSED' : 'ANSWERED'
  const text = ws.mutate('requests', current => {
    const updated = replaceSectionRaw(current, id, raw => {
      const withFields = setFields(raw, [
        { label: 'Status', value: status },
        { label: 'Updated', value: now },
      ])
      return `${withFields.trimEnd()}\n\n${renderAnswer({ agent: identity.agent, timestamp: now, body: escapeBody(body) })}`
    })
    if (updated === undefined) throw new CoordinationError(`${id} does not exist in REQUESTS.md`)
    return updated
  })
  const request = parseRequests(text).find(r => r.id.toLowerCase() === id.toLowerCase())!
  ws.emit(identity, 'REQUEST_ANSWERED', `answered ${request.id} from ${request.from}: ${preview(body, 60)}`, request.id)
  return request
}

export function closeRequest(ws: Workspace, identity: Identity, id: string): Request {
  assertAgentId(identity.agent)
  const now = isoNow()
  const text = ws.mutate('requests', current => {
    const updated = replaceSectionRaw(current, id, raw =>
      setFields(raw, [
        { label: 'Status', value: 'CLOSED' },
        { label: 'Updated', value: now },
      ]),
    )
    if (updated === undefined) throw new CoordinationError(`${id} does not exist in REQUESTS.md`)
    return updated
  })
  const request = parseRequests(text).find(r => r.id.toLowerCase() === id.toLowerCase())!
  ws.emit(identity, 'REQUEST_CLOSED', `closed ${request.id}`, request.id)
  return request
}

// ---------------------------------------------------------------- milestones

export function addMilestone(ws: Workspace, identity: Identity, title: string, note = ''): Milestone {
  assertAgentId(identity.agent)
  if (!title.trim()) throw new CoordinationError('A milestone needs a title')
  const timestamp = isoNow()
  let milestone: Milestone | undefined
  ws.appendRecord('milestones', current => {
    milestone = { id: nextId(current, 'MILESTONE'), title: oneLineText(title, 300), agent: identity.agent, timestamp, note: escapeBody(note) }
    return `${meta(identity, 'MILESTONE_REACHED', timestamp, milestone.id)}\n${renderMilestone(milestone)}`
  })
  ws.emit(identity, 'MILESTONE_REACHED', `reached ${milestone!.id} ${milestone!.title}`, milestone!.id)
  return milestone!
}

export function listMilestones(ws: Workspace): Milestone[] {
  return parseMilestones(readText(ws.path('milestones')))
}
