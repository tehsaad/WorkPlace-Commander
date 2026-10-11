import { EVENT_TYPES } from '../types.ts'
import type { WorkspaceEvent, WorkspaceEventType } from '../types.ts'

/**
 * The machine-readable event block embedded in Markdown. Pure.
 *
 *   <!-- WC_EVENT
 *   id: evt_lq2x8k_3f9a1c
 *   type: TASK_COMPLETED
 *   agent: Claude-01
 *   session: sess_8821
 *   timestamp: 2026-10-08T19:41:20+05:00
 *   ref: TASK-003
 *   -->
 *   - 19:41 **Claude-01** completed TASK-003 Implement backend
 *
 * The HTML comment is invisible in Obsidian's reading view, so the note stays
 * clean for humans while other AI tools can parse the block reliably.
 */

function pad(n: number, width = 2): string {
  return String(Math.abs(Math.trunc(n))).padStart(width, '0')
}

/** ISO 8601 with the local UTC offset: 2026-10-08T19:41:20+05:00. */
export function isoNow(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  )
}

/** `2026-10-08 19:41` for human-facing lines. */
export function humanTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso)
  return match ? `${match[1]} ${match[2]}` : iso
}

/** `19:41` */
export function clockTime(iso: string): string {
  const match = /[T ](\d{2}:\d{2})/.exec(iso)
  return match?.[1] ?? iso
}

function randomSuffix(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/** Unique, time-ordered event id: evt_<ms base36>_<random>. */
export function newEventId(now: number = Date.now()): string {
  return `evt_${now.toString(36)}_${randomSuffix(6)}`
}

export function newSessionId(now: number = Date.now()): string {
  return `sess_${now.toString(36)}${randomSuffix(4)}`
}

export function isEventType(value: string): value is WorkspaceEventType {
  return (EVENT_TYPES as readonly string[]).includes(value)
}

/** Strips newlines so a value cannot break out of the metadata block. */
function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replace(/-->/g, '—>').trim()
}

export function formatEventMeta(event: WorkspaceEvent): string {
  const lines = [
    '<!-- WC_EVENT',
    `id: ${event.id}`,
    `type: ${event.type}`,
    `agent: ${oneLine(event.agent)}`,
    `session: ${oneLine(event.session)}`,
    `timestamp: ${event.timestamp}`,
  ]
  if (event.ref) lines.push(`ref: ${oneLine(event.ref)}`)
  lines.push('-->')
  return lines.join('\n')
}

/** Metadata block plus the one-line human summary used in SESSION_LOG.md. */
export function formatEventLine(event: WorkspaceEvent): string {
  return `${formatEventMeta(event)}\n- ${clockTime(event.timestamp)} **${event.agent}** ${oneLine(event.summary)}`
}

const EVENT_BLOCK = /<!--\s*WC_EVENT\s*\n([\s\S]*?)-->\s*\n?(?:- (?:\d{2}:\d{2} )?(?:\*\*[^*]*\*\* )?(.*))?/g

/** Parses every WC_EVENT block in a document, in document order. */
export function parseEvents(text: string): WorkspaceEvent[] {
  const events: WorkspaceEvent[] = []
  for (const match of text.matchAll(EVENT_BLOCK)) {
    const fields: Record<string, string> = {}
    for (const line of (match[1] ?? '').split('\n')) {
      const kv = /^\s*([a-zA-Z_]+)\s*:\s*(.*?)\s*$/.exec(line)
      if (kv?.[1]) fields[kv[1].toLowerCase()] = kv[2] ?? ''
    }
    const type = fields.type ?? ''
    if (!fields.id || !isEventType(type)) continue
    events.push({
      id: fields.id,
      type,
      agent: fields.agent ?? 'unknown',
      session: fields.session ?? '',
      timestamp: fields.timestamp ?? '',
      ...(fields.ref ? { ref: fields.ref } : {}),
      summary: (match[2] ?? '').trim(),
    })
  }
  return events
}
