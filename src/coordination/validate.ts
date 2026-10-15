/**
 * Input validation for everything that ends up in the shared Markdown. Pure:
 * shared by the CLI, the dashboard server and the hooks module.
 *
 * The record files are parsed by their `##` / `###` headings, so free text
 * written into them must not be able to start a heading of its own: a
 * message body containing `## MSG-900 · Lead-01 → ALL` would otherwise forge
 * a message from another agent.
 */

/** Agent ids: `Claude-01`, `Gemini-CLI-01`, `Human-01`. One token, no markup. */
export const AGENT_ID_PATTERN = /^[A-Za-z][\w.-]{0,40}$/

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value)
}

/** Returns the id when valid; throws a ValidationError naming `what` otherwise. */
export function assertAgentId(value: string | undefined, what = 'agent id'): string {
  const id = (value ?? '').trim()
  if (!isAgentId(id)) {
    throw new ValidationError(
      `Invalid ${what} ${JSON.stringify(value ?? '')}: use a letter, then letters, digits, '.', '_' or '-' (at most 41), e.g. Gemini-01`,
    )
  }
  return id
}

/** A message or request recipient: an agent id or ALL. */
export function assertRecipient(value: string | undefined): string {
  const to = (value ?? '').trim()
  if (to.toUpperCase() === 'ALL') return 'ALL'
  return assertAgentId(to, 'recipient')
}

/** Collapses a value to one line of at most `max` characters. */
export function oneLineText(value: string, max = 500): string {
  const flat = value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const HEADING_LINE = /^( {0,3})(#{2,3})(?=[ \t]|$)/gm

/**
 * Makes free text safe to embed in a record body: lines that would start a
 * `##` record or a `###` answer heading are escaped (`\##`, which Markdown
 * still renders as `##`), HTML comments are defused so a body cannot hide
 * text or imitate a WC_EVENT block, and an unclosed code fence is closed (the
 * parser ignores headings inside fences, so an open one would swallow every
 * record appended after it). `unescapeBody` reverses the escapes for display.
 */
export function escapeBody(text: string): string {
  let out = text.replace(/\r\n?/g, '\n').replace(HEADING_LINE, '$1\\$2').replace(/<!--/g, '<\\!--')
  const fences = out.split('\n').filter(line => /^\s*(```|~~~)/.test(line)).length
  if (fences % 2 === 1) out = `${out.trimEnd()}\n\`\`\``
  return out
}

export function unescapeBody(text: string): string {
  return text.replace(/^( {0,3})\\(#{2,3})(?=[ \t]|$)/gm, '$1$2').replace(/<\\!--/g, '<!--')
}
