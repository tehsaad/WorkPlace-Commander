import type { DashboardModel } from './model.ts'
import { formatElapsed } from './model.ts'

/** Renders the dashboard as plain text for terminals (`wsc status`). Pure. */
export function renderTextDashboard(
  model: DashboardModel,
  options: { width?: number; elapsedMs?: number; showGit?: boolean; color?: boolean } = {},
): string {
  const width = Math.max(60, Math.min(options.width ?? 78, 120))
  const inner = width - 4
  const dim = (s: string) => (options.color ? `\x1b[2m${s}\x1b[22m` : s)
  const bold = (s: string) => (options.color ? `\x1b[1m${s}\x1b[22m` : s)
  const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
  // Visible length ignores ANSI escapes so padding stays aligned in color mode.
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length
  const row = (s = '') => `│ ${s}${' '.repeat(Math.max(0, inner - visible(s)))} │`
  const rule = (label?: string) =>
    label ? `├─ ${label} ${'─'.repeat(Math.max(0, width - label.length - 5))}┤` : `├${'─'.repeat(width - 2)}┤`

  const out: string[] = []
  const title = 'WORKSPACE COMMANDER'
  out.push(`┌${'─'.repeat(width - 2)}┐`)
  out.push(row(`${bold(title)}${' '.repeat(Math.max(1, inner - title.length - model.project.length))}${dim(model.project)}`))
  out.push(rule())
  const c = model.counts
  const online = model.agents.filter(a => a.isOnline)
  out.push(
    row(
      `${dim('TIME')} ${options.elapsedMs === undefined ? '--:--:--' : formatElapsed(options.elapsedMs)}   ` +
        `${dim('TASKS')} ${c.completed} done · ${c.ongoing} ongoing · ${c.pending} pending · ${c.blocked} blocked`,
    ),
  )
  out.push(rule('AGENTS'))
  if (online.length === 0) out.push(row(dim('No agents online.')))
  for (const a of online) out.push(row(`${fit(a.id + (a.isSelf ? ' (you)' : ''), 22)} ${fit(a.status, 10)} ${dim(fit(a.task, inner - 34))}`))
  out.push(rule('CURRENT WORK'))
  if (model.work.length === 0) out.push(row(dim('No open tasks.')))
  for (const w of model.work.slice(0, 8)) {
    const mark = w.status === 'IN_PROGRESS' || w.status === 'REVIEW' ? '●' : '○'
    out.push(row(`${mark} ${fit(`${w.id} ${w.title}`, inner - 35)} ${fit(w.owner || '-', 16)} ${fit(w.progressLabel, 8)} ${fit(w.duration, 6)}`))
  }
  if (model.openRequests.length) {
    out.push(rule('OPEN REQUESTS'))
    for (const r of model.openRequests.slice(0, 5)) out.push(row(`${fit(r.id, 12)} ${fit(`${r.from} → ${r.to}`, 30)} ${dim(fit(r.title, inner - 44))}`))
  }
  out.push(rule('RECENT ACTIVITY'))
  if (model.activity.length === 0) out.push(row(dim('Nothing yet.')))
  for (const a of model.activity.slice(0, 6)) out.push(row(`${dim(a.time)} ${fit(`${a.agent} ${a.text}`, inner - 6)}`))
  if (model.milestones.length) {
    out.push(rule('MILESTONES'))
    for (const m of model.milestones) out.push(row(`${fit(m.title, inner - 20)} ${dim(fit(m.agent, 18))}`))
  }
  if (options.showGit !== false) {
    out.push(rule('GIT'))
    if (model.commits.length === 0) out.push(row(dim('No commits.')))
    for (const commit of model.commits) out.push(row(`${dim(commit.hash.padEnd(9))}${fit(commit.subject, inner - 9)}`))
  }
  out.push(`└${'─'.repeat(width - 2)}┘`)
  return out.join('\n')
}
