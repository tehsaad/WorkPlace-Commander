// The hooks module's $.state contract. Structural copies of src/types.ts
// (a contract file is self-contained: no imports).

export type WcAgentStatus = 'IDLE' | 'PLANNING' | 'WORKING' | 'BLOCKED' | 'WAITING' | 'REVIEWING' | 'COMPLETED'
export type WcTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'REVIEW' | 'BLOCKED' | 'DONE'

export type WcAgent = {
  id: string
  status: WcAgentStatus
  task: string
  branch: string
  session: string
  kind: string
  started: string
  lastActivity: string
  workingState: string
  online: boolean
}

export type WcTask = {
  id: string
  title: string
  status: WcTaskStatus
  owner: string
  progress?: number
  depends: string[]
  created: string
  updated: string
  started: string
  completed: string
  notes: string
}

export type WcMessage = { id: string; from: string; to: string; timestamp: string; body: string }

export type WcRequest = {
  id: string
  title: string
  status: 'OPEN' | 'ANSWERED' | 'CLOSED'
  from: string
  to: string
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  created: string
  updated: string
  question: string
  answers: { agent: string; timestamp: string; body: string }[]
}

export type WcMilestone = { id: string; title: string; agent: string; timestamp: string; note: string }

export type WcCommit = { hash: string; subject: string }

export type WcCommitRecord = WcCommit & { agent: string; timestamp: string; branch: string }

export type WcEvent = {
  id: string
  type:
    | 'AGENT_REGISTERED'
    | 'AGENT_STATUS'
    | 'SESSION_STARTED'
    | 'SESSION_ENDED'
    | 'PLAN_CREATED'
    | 'TASK_CREATED'
    | 'TASK_CLAIMED'
    | 'TASK_RELEASED'
    | 'TASK_STATUS'
    | 'TASK_COMPLETED'
    | 'MESSAGE_SENT'
    | 'REQUEST_CREATED'
    | 'REQUEST_ANSWERED'
    | 'REQUEST_CLOSED'
    | 'MILESTONE_REACHED'
    | 'COMMIT_CREATED'
  agent: string
  session: string
  timestamp: string
  ref?: string
  summary: string
}

export type WcSnapshot = {
  project: string
  workspace: string
  agents: WcAgent[]
  tasks: WcTask[]
  requests: WcRequest[]
  messages: WcMessage[]
  milestones: WcMilestone[]
  commits: WcCommitRecord[]
  events: WcEvent[]
  plan: string
}

export type WcFiles = {
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

/** Who this session is in the workspace, set once the agent registered. */
export type WcSelf = {
  agentId: string
  session: string
  cwd: string
  workspace: string
  project: string
  files: WcFiles
  staleMinutes: number
  gitLogCount: number
  autoWake: boolean
  /** Epoch ms the session started; survives hot reloads and restarts of the session. */
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'workspace-commander': {
      self: WcSelf | null
      snapshot: WcSnapshot | null
      commits: WcCommit[]
      gitVisible: boolean
      now: number
      live: boolean
      error: string | null
    }
  }
}
