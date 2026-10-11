/**
 * The Workspace Commander pane: a compact, IDE-style dashboard drawn with the
 * surface's own elements and theme colors (dark in a dark theme), one
 * restrained accent, no animation beyond the ticking session timer.
 */
import type { ElementConstructor, BoxProps, ButtonProps, RenderElement, TextProps } from 'claude-code'

import { buildDashboard, formatElapsed } from '../dashboard/model.ts'
import type { WcCommit, WcSelf, WcSnapshot } from '../../types'

/** The three elements the pane uses; every surface's table has them. */
export interface PaneElements {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/** Everything the pane draws from, read from $.state by the hooks module. */
export interface PaneData {
  self: WcSelf | null
  snapshot: WcSnapshot | null
  commits: readonly WcCommit[]
  gitVisible: boolean
  now: number
  live: boolean
  error: string | null
  /** The pane body's width in cells (`e.props.bodyColumns`). */
  columns: number
}

const AGENT_COLOR: Record<string, string | undefined> = {
  WORKING: 'success',
  REVIEWING: 'suggestion',
  WAITING: 'warning',
  BLOCKED: 'error',
  PLANNING: 'suggestion',
}

const TASK_COLOR: Record<string, string | undefined> = {
  IN_PROGRESS: 'success',
  REVIEW: 'suggestion',
  BLOCKED: 'error',
}

function fit(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

/**
 * Builds the pane's tree. Pure: `onToggleGit` is the handler the hooks module
 * binds (the same function /togglegit calls), so both control one state.
 */
export function renderDashboard(els: PaneElements, data: PaneData, onToggleGit: () => unknown): RenderElement {
  const { Box, Text, Button } = els
  const { self, snapshot, commits, gitVisible, now, live, error } = data
  const width = Math.max(44, data.columns)
  const rule = <Text color="subtle">{'─'.repeat(width)}</Text>
  const label = (text: string) => (
    <Text color="subtle" bold>
      {text}
    </Text>
  )

  const header = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text bold>WORKSPACE COMMANDER</Text>
      <Text color={live ? 'success' : 'subtle'}>{live ? '● LIVE' : '○ OFFLINE'}</Text>
    </Box>
  )

  if (!self || !snapshot) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {rule}
        <Text color={error ? 'error' : 'subtle'}>{error ?? 'Connecting to the workspace…'}</Text>
      </Box>
    )
  }

  const clock = now || Date.now()
  const model = buildDashboard(snapshot, {
    now: clock,
    self: self.agentId,
    staleMinutes: self.staleMinutes,
    commits,
  })
  const online = model.agents.filter(a => a.isOnline)
  const c = model.counts
  const narrow = width < 64
  const ownerWidth = narrow ? 12 : 16
  const statusWidth = 9
  const durWidth = 7
  const titleWidth = width - 2 - ownerWidth - statusWidth - durWidth - 3

  const stat = (n: number, word: string, color?: string) => (
    <Text>
      <Text bold color={n > 0 ? color : undefined}>
        {String(n)}
      </Text>
      <Text color="subtle"> {word}</Text>
    </Text>
  )

  return (
    <Box flexDirection="column" width={width}>
      {header}
      <Text>
        <Text>{model.project}</Text>
        <Text color="subtle">{`  ·  ${self.agentId}  ·  ${self.workspace}`}</Text>
      </Text>
      {rule}

      <Box flexDirection={narrow ? 'column' : 'row'} width={width} columnGap={3}>
        <Box flexDirection="column" minWidth={12}>
          {label('SESSION')}
          <Text bold>{formatElapsed(clock - self.startedAt)}</Text>
        </Box>
        <Box flexDirection="column" minWidth={22}>
          {label('TASKS')}
          <Box flexDirection="row" columnGap={2}>
            {stat(c.completed, 'done')}
            {stat(c.ongoing, 'ongoing', 'success')}
          </Box>
          <Box flexDirection="row" columnGap={2}>
            {stat(c.pending, 'pending')}
            {stat(c.blocked, 'blocked', 'error')}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {label(`AGENTS · ${online.length} online`)}
          {online.length === 0 && <Text color="subtle">none</Text>}
          {online.slice(0, 5).map(a => (
            <Text>
              <Text bold={a.isSelf}>{fit(a.id + (a.isSelf ? '*' : ''), 17)}</Text>
              <Text color={AGENT_COLOR[a.status] ?? 'subtle'}>{a.status}</Text>
            </Text>
          ))}
        </Box>
      </Box>
      {rule}

      {label('CURRENT WORK')}
      {model.work.length === 0 && <Text color="subtle">No open tasks. Create a plan with plan_create or edit TASKS.md.</Text>}
      {model.work.slice(0, 8).map(w => (
        <Text>
          <Text color={TASK_COLOR[w.status] ?? 'subtle'}>{w.status === 'PENDING' ? '○ ' : '● '}</Text>
          <Text>{fit(`${w.id.replace('TASK-', '#')} ${w.title}`, titleWidth)}</Text>
          <Text color="subtle"> {fit(w.owner || '—', ownerWidth)}</Text>
          <Text color={TASK_COLOR[w.status] ?? 'subtle'}> {fit(w.progressLabel, statusWidth)}</Text>
          <Text color="subtle"> {fit(w.duration, durWidth)}</Text>
        </Text>
      ))}
      {model.work.length > 8 && <Text color="subtle">{`+ ${model.work.length - 8} more in TASKS.md`}</Text>}

      {model.openRequests.length > 0 && rule}
      {model.openRequests.length > 0 && label(`OPEN REQUESTS · ${model.openRequests.length}`)}
      {model.openRequests.slice(0, 4).map(r => (
        <Text>
          <Text color={r.to === self.agentId ? 'warning' : undefined}>{fit(r.id, 12)}</Text>
          <Text color="subtle">{fit(`${r.from} → ${r.to}`, 30)}</Text>
          <Text>{fit(r.title, Math.max(8, width - 43))}</Text>
        </Text>
      ))}
      {rule}

      {label('RECENT ACTIVITY')}
      {model.activity.length === 0 && <Text color="subtle">Nothing yet.</Text>}
      {model.activity.slice(0, 6).map(a => (
        <Text>
          <Text color="subtle">{a.time} </Text>
          <Text>{fit(`${a.agent} ${a.text}`, width - 6)}</Text>
        </Text>
      ))}

      {model.milestones.length > 0 && rule}
      {model.milestones.length > 0 && label('MILESTONES')}
      {model.milestones.map(m => (
        <Text>
          <Text color="success">◆ </Text>
          <Text>{fit(m.title, width - 22)}</Text>
          <Text color="subtle"> {m.agent}</Text>
        </Text>
      ))}
      {rule}

      <Box flexDirection="row" justifyContent="space-between" width={width}>
        {label(gitVisible ? 'GIT' : 'GIT · hidden')}
        <Button key="toggle-git" label={gitVisible ? 'Hide Git' : 'Show Git'} hotkey="g" onPress={onToggleGit} />
      </Box>
      {gitVisible && commits.length === 0 && <Text color="subtle">No commits.</Text>}
      {gitVisible &&
        commits.map(commit => (
          <Text>
            <Text color="suggestion">{commit.hash.padEnd(9)}</Text>
            <Text>{fit(commit.subject, width - 9)}</Text>
          </Text>
        ))}
    </Box>
  )
}
