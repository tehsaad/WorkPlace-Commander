// Checks what a live agent left in the workspace:
//   node verify-live.mjs <workspaceDir> <agentPrefix> <taskId>
// Prints one JSON line and exits 0 only when the agent registered with its
// kind, claimed and completed the task, and messaged Lead-01.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseAgents, parseEvents, parseMessages, parseTasks } from '../../dist/index.js'

const [dir, prefix, taskId] = process.argv.slice(2)
const read = name => {
  try {
    return readFileSync(join(dir, name), 'utf8')
  } catch {
    return ''
  }
}
const task = parseTasks(read('TASKS.md')).find(t => t.id === taskId)
const owner = task?.owner ?? ''
const agent = parseAgents(read('AGENTS.md')).find(a => a.id === owner)
const message = parseMessages(read('MESSAGES.md')).find(m => m.from === owner && m.to === 'Lead-01')
const events = parseEvents(read('SESSION_LOG.md')).filter(e => e.agent === owner).map(e => e.type)
const checks = {
  ownerMatchesTool: owner.startsWith(prefix),
  registeredWithKind: Boolean(agent && agent.kind && agent.kind !== 'unknown'),
  claimed: events.includes('TASK_CLAIMED'),
  completed: task?.status === 'DONE',
  messagedLead: Boolean(message && /ack from/i.test(message.body)),
}
const ok = Object.values(checks).every(Boolean)
process.stdout.write(
  JSON.stringify({ ok, owner, kind: agent?.kind, capabilities: agent?.capabilities, message: message?.body, events, checks }) + '\n',
)
process.exitCode = ok ? 0 : 1
