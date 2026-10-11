import { parseEvents } from '../events/format.ts'
import type { WorkspaceFiles, WorkspaceSnapshot } from '../types.ts'
import { parseAgents, parseCommits, parseMessages, parseMilestones, parseRequests, parseTasks } from './records.ts'

/** The workspace files a snapshot reads, keyed by role. Pure. */
export const SNAPSHOT_FILES = ['agents', 'tasks', 'requests', 'messages', 'milestones', 'commits', 'sessionLog', 'plan'] as const
export type SnapshotFile = (typeof SNAPSHOT_FILES)[number]

export function snapshotPaths(workspace: string, files: WorkspaceFiles): Record<SnapshotFile, string> {
  const join = (name: string) => `${workspace.replace(/\/+$/, '')}/${name}`
  return {
    agents: join(files.agents),
    tasks: join(files.tasks),
    requests: join(files.requests),
    messages: join(files.messages),
    milestones: join(files.milestones),
    commits: join(files.commits),
    sessionLog: join(files.sessionLog),
    plan: join(files.plan),
  }
}

/** Builds a snapshot from file contents (missing files = ''). */
export function buildSnapshot(
  project: string,
  workspace: string,
  texts: Partial<Record<SnapshotFile, string>>,
  limits: { events?: number; messages?: number } = {},
): WorkspaceSnapshot {
  const events = parseEvents(texts.sessionLog ?? '')
  const messages = parseMessages(texts.messages ?? '')
  return {
    project,
    workspace,
    agents: parseAgents(texts.agents ?? ''),
    tasks: parseTasks(texts.tasks ?? ''),
    requests: parseRequests(texts.requests ?? ''),
    messages: messages.slice(-(limits.messages ?? 200)),
    milestones: parseMilestones(texts.milestones ?? ''),
    commits: parseCommits(texts.commits ?? ''),
    events: events.slice(-(limits.events ?? 200)),
    plan: texts.plan ?? '',
  }
}
