/**
 * The coordination tools, shared by every surface: the Claude Code mod
 * registers them as plugin tools, `wsc mcp` serves them to any MCP client
 * (Gemini CLI, Antigravity, Codex, Cursor, ...). Each maps onto one `wsc`
 * invocation, so a tool call from any agent and a CLI call are held to the
 * same locking and the same protocol rules. Pure: no Node, no host types.
 */

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Claude Code only: keep the tool loaded instead of deferred. */
  isDeferred?: boolean
}

export interface CoordinationTool {
  spec: ToolSchema
  /** Where the tool is offered; both when omitted. */
  surfaces?: ReadonlyArray<'mod' | 'mcp'>
  /** Builds the wsc argv from the model's input. */
  args: (input: Record<string, unknown>) => string[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : str(value) ? [str(value)] : [])
const repeat = (flag: string, values: string[]) => values.flatMap(v => [flag, v])

const TASK_STATUS = ['PENDING', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE']
const AGENT_STATUS = ['IDLE', 'PLANNING', 'WORKING', 'BLOCKED', 'WAITING', 'REVIEWING', 'COMPLETED']

export const COORDINATION_TOOLS: Record<string, CoordinationTool> = {
  workspace_status: {
    spec: {
      name: 'workspace_status',
      description:
        'Shared multi-agent workspace: which agents are online and what they work on, every task with owner and status, open requests, and unread messages for you. Call before significant changes and before choosing a task.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    },
    // The Claude Code mod answers this one itself (its own dashboard text);
    // every other surface gets the agent's context and marks it delivered.
    args: () => ['context', '--mark-read'],
  },
  plan_create: {
    spec: {
      name: 'plan_create',
      description:
        'Write the shared PLAN.md before significant multi-step work and create one task per item (existing open tasks with the same title are reused). Archives any previous plan.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Task titles, in order' },
          assignments: { type: 'array', items: { type: 'string' }, description: '"Agent-ID=Area" pairs, e.g. "Antigravity-01=Frontend"' },
          dependencies: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['objective', 'tasks'],
      },
    },
    args: i => [
      'plan',
      'create',
      '--objective',
      str(i.objective),
      ...repeat('--task', list(i.tasks)),
      ...repeat('--assign', list(i.assignments)),
      ...repeat('--dep', list(i.dependencies)),
      ...(str(i.notes) ? ['--note', str(i.notes)] : []),
    ],
  },
  task_add: {
    spec: {
      name: 'task_add',
      description: 'Add one task to the shared TASKS.md (deduplicated by title).',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, depends: { type: 'array', items: { type: 'string' }, description: 'TASK ids' } },
        required: ['title'],
      },
    },
    args: i => ['task', 'add', str(i.title), ...repeat('--depends', list(i.depends))],
  },
  task_claim: {
    spec: {
      name: 'task_claim',
      description:
        'Claim a shared task before working on it. Fails when another online agent owns it: then message them or pick another task. Use force only after the owner agreed to hand over.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'e.g. TASK-003' }, force: { type: 'boolean' } },
        required: ['task_id'],
      },
      isDeferred: false,
    },
    args: i => ['task', 'claim', str(i.task_id), ...(i.force === true ? ['--force'] : [])],
  },
  task_update: {
    spec: {
      name: 'task_update',
      description: 'Report progress or a status change on a task you own (IN_PROGRESS with progress %, REVIEW, BLOCKED with a reason).',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: TASK_STATUS },
          progress: { type: 'number', minimum: 0, maximum: 100 },
          note: { type: 'string' },
        },
        required: ['task_id', 'status'],
      },
      isDeferred: false,
    },
    args: i => [
      'task',
      'status',
      str(i.task_id),
      str(i.status),
      ...(typeof i.progress === 'number' ? ['--progress', String(i.progress)] : []),
      ...(str(i.note) ? ['--note', str(i.note)] : []),
    ],
  },
  task_complete: {
    spec: {
      name: 'task_complete',
      description: 'Mark a task you own DONE (ticks it in PLAN.md).',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id'] },
      isDeferred: false,
    },
    args: i => ['task', 'done', str(i.task_id), ...(str(i.note) ? ['--note', str(i.note)] : [])],
  },
  task_release: {
    spec: {
      name: 'task_release',
      description: 'Give up a task you own so another agent can take it.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id'] },
    },
    args: i => ['task', 'release', str(i.task_id), ...(str(i.note) ? ['--note', str(i.note)] : [])],
  },
  message_send: {
    spec: {
      name: 'message_send',
      description: 'Send a message to another agent (by agent ID) or to ALL via the shared MESSAGES.md.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
      isDeferred: false,
    },
    args: i => ['msg', 'send', '--to', str(i.to), str(i.body)],
  },
  request_create: {
    spec: {
      name: 'request_create',
      description:
        'Ask another agent (or ALL) for input, a review, or a decision. Creates REQUEST-NNN in REQUESTS.md; you are notified when it is answered.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          question: { type: 'string' },
          title: { type: 'string', description: 'Short summary' },
          priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
        },
        required: ['to', 'question'],
      },
      isDeferred: false,
    },
    args: i => [
      'request',
      'create',
      '--to',
      str(i.to),
      ...(str(i.title) ? ['--title', str(i.title)] : []),
      ...(str(i.priority) ? ['--priority', str(i.priority)] : []),
      str(i.question),
    ],
  },
  request_answer: {
    spec: {
      name: 'request_answer',
      description: 'Answer a request addressed to you (appends the answer, sets ANSWERED; close=true sets CLOSED).',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'string' }, answer: { type: 'string' }, close: { type: 'boolean' } },
        required: ['request_id', 'answer'],
      },
      isDeferred: false,
    },
    args: i => ['request', 'answer', str(i.request_id), str(i.answer), ...(i.close === true ? ['--close'] : [])],
  },
  request_close: {
    spec: {
      name: 'request_close',
      description: 'Close one of your requests once its answer is sufficient.',
      inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] },
    },
    args: i => ['request', 'close', str(i.request_id)],
  },
  milestone: {
    spec: {
      name: 'milestone',
      description: 'Record a milestone reached (a feature working end to end, a phase finished).',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'] },
    },
    args: i => ['milestone', str(i.title), ...(str(i.note) ? ['--note', str(i.note)] : [])],
  },
  agent_status: {
    spec: {
      name: 'agent_status',
      description: 'Set your agent status in AGENTS.md (e.g. WAITING on a request, PLANNING, REVIEWING) with a short working-state line.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: AGENT_STATUS }, working_state: { type: 'string' } },
        required: ['status'],
      },
    },
    args: i => ['agent', 'status', str(i.status), ...(str(i.working_state) ? ['--state', str(i.working_state)] : [])],
  },
  context_note: {
    spec: {
      name: 'context_note',
      description:
        'Add a short dated note to the shared project context (the Notes section of ProjectNotes.md): a decision, a convention, a finding other agents should know.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    args: i => ['note', 'add', str(i.text)],
  },
  request_wait: {
    spec: {
      name: 'request_wait',
      description:
        'Wait until one of your requests is answered (or the timeout passes) and return it. For tools that are not woken by new answers; keep timeout_seconds below your tool-call timeout.',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'string' }, timeout_seconds: { type: 'number', minimum: 1, maximum: 600 } },
        required: ['request_id'],
      },
    },
    surfaces: ['mcp'],
    args: i => ['request', 'wait', str(i.request_id), '--timeout', String(typeof i.timeout_seconds === 'number' ? i.timeout_seconds : 45)],
  },
}

export const COORDINATION_TOOL_NAMES = Object.keys(COORDINATION_TOOLS)
