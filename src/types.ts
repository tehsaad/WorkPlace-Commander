/**
 * Core domain types for Workspace Commander.
 *
 * This file is pure (no Node imports): it is shared by the host-side CLI and
 * by the Claude Code hooks module, which runs in a sandbox without Node.
 */

export const AGENT_STATUSES = [
  'IDLE',
  'PLANNING',
  'WORKING',
  'BLOCKED',
  'WAITING',
  'REVIEWING',
  'COMPLETED',
] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const REQUEST_STATUSES = ['OPEN', 'ANSWERED', 'CLOSED'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type Priority = (typeof PRIORITIES)[number]

/** One agent as recorded in AGENTS.md. */
export interface Agent {
  id: string
  status: AgentStatus
  /** Free text, usually `TASK-003 Implement authentication`. */
  task: string
  branch: string
  session: string
  /** `claude-code`, `antigravity`, `human`, ... */
  kind: string
  started: string
  lastActivity: string
  workingState: string
  online: boolean
}

/** A live session of an agent (SESSIONS/<agent>.md header). */
export interface Session {
  id: string
  agent: string
  started: string
  ended?: string
  cwd: string
  branch: string
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  owner: string
  /** 0-100, or undefined when unknown. */
  progress?: number
  depends: string[]
  created: string
  updated: string
  started: string
  completed: string
  notes: string
}

export interface Message {
  id: string
  from: string
  to: string
  timestamp: string
  body: string
}

export interface RequestAnswer {
  agent: string
  timestamp: string
  body: string
}

export interface Request {
  id: string
  title: string
  status: RequestStatus
  from: string
  to: string
  priority: Priority
  created: string
  updated: string
  question: string
  answers: RequestAnswer[]
}

export interface Milestone {
  id: string
  title: string
  agent: string
  timestamp: string
  note: string
}

export interface GitCommit {
  hash: string
  subject: string
}

export interface CommitRecord extends GitCommit {
  agent: string
  timestamp: string
  branch: string
}

export const EVENT_TYPES = [
  'AGENT_REGISTERED',
  'AGENT_STATUS',
  'SESSION_STARTED',
  'SESSION_ENDED',
  'PLAN_CREATED',
  'TASK_CREATED',
  'TASK_CLAIMED',
  'TASK_RELEASED',
  'TASK_STATUS',
  'TASK_COMPLETED',
  'MESSAGE_SENT',
  'REQUEST_CREATED',
  'REQUEST_ANSWERED',
  'REQUEST_CLOSED',
  'MILESTONE_REACHED',
  'COMMIT_CREATED',
] as const
export type WorkspaceEventType = (typeof EVENT_TYPES)[number]

/** One entry of the append-only event stream (SESSION_LOG.md). */
export interface WorkspaceEvent {
  id: string
  type: WorkspaceEventType
  agent: string
  session: string
  timestamp: string
  /** The record the event is about: TASK-003, REQUEST-009, a commit hash. */
  ref?: string
  /** The one-line human summary shown after the metadata block. */
  summary: string
}

/** File names inside the workspace folder; every one is configurable. */
export interface WorkspaceFiles {
  projectNotes: string
  agents: string
  plan: string
  tasks: string
  messages: string
  requests: string
  milestones: string
  commits: string
  sessionLog: string
  sessionsDir: string
  protocol: string
}

export interface Config {
  /** Absolute or `~`-relative path of the Obsidian vault. */
  obsidianVault: string
  /** Folder inside the vault that holds this workspace. */
  workspaceDir: string
  /** Kept at the top level for the documented `{ obsidianVault, projectNotes }` shape. */
  projectNotes: string
  /** Display name; defaults to the git repository's folder name. */
  project?: string
  /** Prefix for auto-allocated agent IDs (Claude -> Claude-01). */
  agentPrefix: string
  /** An agent is shown as offline after this many minutes without activity. */
  staleAgentMinutes: number
  /** A lock older than this is considered abandoned and is taken over. */
  lockStaleMs: number
  /** Number of commits the Git panel shows. */
  gitLogCount: number
  /** Wake an idle Claude session when a message or answer arrives for it. */
  autoWake: boolean
  files: Omit<WorkspaceFiles, 'projectNotes'>
}

/** Everything a reader needs to draw the workspace; produced by parsing the Markdown. */
export interface WorkspaceSnapshot {
  project: string
  workspace: string
  agents: Agent[]
  tasks: Task[]
  requests: Request[]
  messages: Message[]
  milestones: Milestone[]
  commits: CommitRecord[]
  events: WorkspaceEvent[]
  plan: string
}
