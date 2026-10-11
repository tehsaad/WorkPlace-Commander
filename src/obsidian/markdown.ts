/**
 * The Markdown record format. Pure: shared by the CLI and the hooks module.
 *
 * Every record file (AGENTS.md, TASKS.md, REQUESTS.md, MESSAGES.md,
 * MILESTONES.md) is a sequence of level-2 sections:
 *
 *   ## TASK-003 · Implement backend
 *   - Status: IN_PROGRESS
 *   - Owner: Claude-01
 *
 *   Free-form notes...
 *
 * The parser is deliberately lenient so humans and other AI tools can edit the
 * files by hand: field lines may be bulleted or not, keys are
 * case-insensitive, `**Key:**` bold is accepted, and unknown content is kept.
 */

export interface Section {
  /** The heading text after `## `. */
  heading: string
  /** The record id (TASK-003, Claude-01) taken from the heading. */
  id: string
  /** The heading's title part after the id and separator. */
  title: string
  /** The full raw text of the section, heading line included. */
  raw: string
}

export interface SplitDocument {
  preamble: string
  sections: Section[]
}

const HEADING_SEPARATOR_LEAD = /^\s*(?:·|:|—|–|-|\|)?\s*/

/** Splits a document into its preamble and level-2 sections, ignoring fenced code. */
export function splitSections(text: string): SplitDocument {
  const lines = text.split('\n')
  let inFence = false
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^## (?!#)/.test(line)) starts.push(index)
  })
  const preamble = lines.slice(0, starts[0] ?? lines.length).join('\n')
  const sections = starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length
    const raw = lines.slice(start, end).join('\n')
    const heading = (lines[start] ?? '').slice(3).trim()
    // The id is the first token ("TASK-010:" counts as TASK-010); the title is
    // what follows any separator: "· title", ": title", "- title", "| title".
    const token = /^\S+/.exec(heading)?.[0] ?? ''
    const id = token.replace(/[:·|]+$/, '')
    const title = heading
      .slice(token.length)
      .replace(HEADING_SEPARATOR_LEAD, '')
      .trim()
    return { heading, id, title, raw }
  })
  return { preamble, sections }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '')
}

const FIELD_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?([A-Za-z][A-Za-z _-]{0,30}?)(?:\*\*)?\s*:(?:\*\*)?\s*(.*?)\s*$/

/**
 * Reads the field lines directly under a section heading. Only `known` keys
 * (normalized: lowercase letters only) are fields; the first line that is not
 * one ends the block, so body text such as "Question: ..." is never captured.
 */
export function parseFields(raw: string, known: readonly string[]): { fields: Record<string, string>; body: string } {
  const lines = raw.split('\n').slice(1)
  const knownSet = new Set(known.map(normalizeKey))
  const fields: Record<string, string> = {}
  let index = 0
  while (index < lines.length && (lines[index] ?? '').trim() === '') index++
  for (; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const match = FIELD_LINE.exec(line)
    const key = match?.[1] ? normalizeKey(match[1]) : ''
    if (!match || !knownSet.has(key)) break
    fields[key] = (match[2] ?? '').trim()
  }
  return { fields, body: lines.slice(index).join('\n').trim() }
}

export interface FieldEntry {
  label: string
  value: string | number | undefined
}

/** Renders a record section; fields with an undefined value are omitted. */
export function renderSection(heading: string, fields: readonly FieldEntry[], body = ''): string {
  const lines = [`## ${heading}`]
  for (const field of fields) {
    if (field.value === undefined) continue
    lines.push(`- ${field.label}: ${String(field.value).replace(/\n/g, ' ')}`)
  }
  const trimmed = body.trim()
  return lines.join('\n') + (trimmed ? `\n\n${trimmed}` : '') + '\n'
}

/**
 * Replaces the section whose id is `id` with `section`, or appends it when
 * missing. Every other byte of the document is preserved.
 */
export function upsertSection(text: string, id: string, section: string): string {
  const doc = splitSections(text)
  const normalized = section.trimEnd() + '\n'
  const index = doc.sections.findIndex(s => s.id.toLowerCase() === id.toLowerCase())
  if (index === -1) {
    const base = text.trimEnd()
    return (base ? `${base}\n\n` : '') + normalized
  }
  const parts = [doc.preamble, ...doc.sections.map((s, i) => (i === index ? normalized : s.raw))]
  return joinParts(parts)
}

function joinParts(parts: string[]): string {
  return (
    parts
      .map(p => p.replace(/\n+$/, ''))
      .filter((p, i) => i > 0 || p !== '')
      .join('\n\n') + '\n'
  )
}

/** Next sequential id for a prefix: TASK-001, TASK-002, ... */
export function nextId(text: string, prefix: string, width = 3): string {
  let max = 0
  const pattern = new RegExp(`\\b${prefix}-(\\d+)\\b`, 'g')
  for (const match of text.matchAll(pattern)) max = Math.max(max, Number(match[1]))
  return `${prefix}-${String(max + 1).padStart(width, '0')}`
}

/** Uppercases and underscores a status word: "in progress" -> IN_PROGRESS. */
export function normalizeWord(value: string): string {
  return value
    .trim()
    .replace(/[`*_]/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
}

/** Splits `Depends: TASK-001, TASK-002` style lists. */
export function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(v => v !== '' && v !== '-' && v.toLowerCase() !== 'none')
}

/** Sets a managed region between markers, appending the region when missing. */
export function setRegion(text: string, name: string, content: string): string {
  const start = `<!-- wc:${name}:start -->`
  const end = `<!-- wc:${name}:end -->`
  const block = `${start}\n${content.trim()}\n${end}`
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex !== -1 && endIndex > startIndex) {
    return text.slice(0, startIndex) + block + text.slice(endIndex + end.length)
  }
  const base = text.trimEnd()
  return (base ? `${base}\n\n` : '') + block + '\n'
}

/**
 * Updates field lines in a section in place, preserving everything else
 * (notes, answers, unknown fields, human formatting). A field that is missing
 * is inserted after the existing field block; `undefined` leaves a field as is.
 */
export function setFields(raw: string, updates: ReadonlyArray<FieldEntry>): string {
  const lines = raw.replace(/\n+$/, '').split('\n')
  // Locate the leading field block (after the heading, skipping blank lines).
  let first = 1
  while (first < lines.length && (lines[first] ?? '').trim() === '') first++
  let last = first
  while (last < lines.length && FIELD_LINE.test(lines[last] ?? '') && (lines[last] ?? '').trim() !== '') last++
  for (const update of updates) {
    if (update.value === undefined) continue
    const value = String(update.value).replace(/\n/g, ' ')
    const key = normalizeKey(update.label)
    let found = false
    for (let i = first; i < last; i++) {
      const match = FIELD_LINE.exec(lines[i] ?? '')
      if (match?.[1] && normalizeKey(match[1]) === key) {
        const bullet = /^\s*[-*]\s+/.test(lines[i] ?? '') ? '- ' : ''
        lines[i] = `${bullet}${update.label}: ${value}`
        found = true
        break
      }
    }
    if (!found) {
      if (last === first && first < lines.length && first > 1) {
        // No field block yet but body text follows a blank line: keep it apart.
        lines.splice(1, 0, `- ${update.label}: ${value}`)
        first = 1
        last = 2
        continue
      }
      lines.splice(last, 0, `- ${update.label}: ${value}`)
      last++
    }
  }
  return lines.join('\n') + '\n'
}

/** Replaces one section's raw text, located by id; returns undefined when absent. */
export function replaceSectionRaw(text: string, id: string, fn: (raw: string) => string): string | undefined {
  const doc = splitSections(text)
  const index = doc.sections.findIndex(s => s.id.toLowerCase() === id.toLowerCase())
  if (index === -1) return undefined
  const parts = [doc.preamble, ...doc.sections.map((s, i) => (i === index ? fn(s.raw) : s.raw))]
  return joinParts(parts)
}
