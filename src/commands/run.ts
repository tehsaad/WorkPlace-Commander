import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { endSession, heartbeat, listAgents, reapStaleAgents, registerAgent, setAgentStatus } from '../agents/agents.ts'
import { loadConfig, registryPath, userConfigPath } from '../config/config.ts'
import { proposeProject, readRegistry, saveProject, unlinkRoot } from '../config/projects.ts'
import { AGENT_TARGETS, agentSetupSnippet, writeAgentSetup } from './setup.ts'
import { DEFAULT_CONFIG } from '../config/defaults.ts'
import {
  addMilestone,
  answerRequest,
  closeRequest,
  createRequest,
  inbox,
  listMessages,
  listRequests,
  sendMessage,
} from '../coordination/messages.ts'
import {
  addTask,
  claimTask,
  completeTask,
  CoordinationError,
  createPlan,
  listTasks,
  releaseTask,
  setTaskStatus,
} from '../coordination/tasks.ts'
import { buildDashboard } from '../dashboard/model.ts'
import { renderTextDashboard } from '../dashboard/text.ts'
import { newSessionId } from '../events/format.ts'
import { readText } from '../filesystem/atomic.ts'
import { watchWorkspace } from '../filesystem/watch.ts'
import { gitDir, gitLog, recordCommit, syncCommits } from '../git/git.ts'
import { Workspace } from '../obsidian/workspace.ts'
import type { Identity } from '../obsidian/workspace.ts'

export const USAGE = `wsc — Workspace Commander

Usage: wsc <command> [subcommand] [args] [--json] [--agent ID] [--session ID]

Setup
  init                                  Create the workspace files in the vault
  config [--init]                       Show resolved configuration (--init writes a default user config)
  status [--width N] [--no-git]         Text dashboard
  snapshot                              Full parsed workspace state (use --json)
  watch                                 Stream change events (JSON lines) until killed

Projects (one workspace folder per project; ~/.config/workspace-commander/projects.json)
  project                               The project and workspace folder this directory resolves to
  projects                              Every registered project
  project register [--name N]           Register this repository; --name of an existing project joins it
  project unregister                    Detach this repository (its notes are kept)
  agent-setup <antigravity|cursor|codex|gemini|generic> --id ID [--write FILE]
                                        One-time standing rule for another AI tool

Agents
  agent register [--id ID | --prefix P] [--kind K] [--branch B]
  agent status <STATUS> [--task T] [--state TEXT]
                                        STATUS: IDLE PLANNING WORKING BLOCKED WAITING REVIEWING COMPLETED
  agent heartbeat [--state TEXT]
  agent end [--reason TEXT]
  agent reap                            Mark agents idle past staleAgentMinutes offline
  agents                                List agents

Planning and tasks
  plan create --objective TEXT --task T [--task T ...] [--assign Agent=Area] [--dep TEXT] [--note TEXT]
  plan show
  task add <title> [--depends TASK-001]
  task claim <TASK-ID> [--force]
  task release <TASK-ID> [--note TEXT]
  task status <TASK-ID> <PENDING|IN_PROGRESS|REVIEW|BLOCKED|DONE> [--progress N] [--note TEXT]
  task done <TASK-ID> [--note TEXT]
  tasks                                 List tasks

Communication
  msg send --to <ID|ALL> <body>
  msg list | msg inbox [--after MSG-ID]
  request create --to <ID|ALL> [--title T] [--priority LOW|NORMAL|HIGH|URGENT] <question>
  request answer <REQUEST-ID> <answer> [--close]
  request close <REQUEST-ID>
  requests [--open]
  milestone <title> [--note TEXT]

Git
  git [-n N]                            git log --oneline -n N
  commit record [--rev REV]             Record a commit (idempotent)
  commit sync                           Record commits no agent recorded

Identity comes from --agent/--session or WSC_AGENT/WSC_SESSION.
Config: ${userConfigPath()} and <repo>/.workspace-commander.json
`

const OPTIONS = {
  agent: { type: 'string' },
  session: { type: 'string' },
  json: { type: 'boolean' },
  config: { type: 'string' },
  cwd: { type: 'string' },
  force: { type: 'boolean' },
  to: { type: 'string' },
  priority: { type: 'string' },
  title: { type: 'string' },
  progress: { type: 'string' },
  note: { type: 'string' },
  depends: { type: 'string', multiple: true },
  task: { type: 'string', multiple: true },
  assign: { type: 'string', multiple: true },
  dep: { type: 'string', multiple: true },
  objective: { type: 'string' },
  id: { type: 'string' },
  name: { type: 'string' },
  write: { type: 'string' },
  prefix: { type: 'string' },
  kind: { type: 'string' },
  branch: { type: 'string' },
  state: { type: 'string' },
  after: { type: 'string' },
  close: { type: 'boolean' },
  rev: { type: 'string' },
  count: { type: 'string', short: 'n' },
  reason: { type: 'string' },
  open: { type: 'boolean' },
  width: { type: 'string' },
  'no-git': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  init: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

export interface CliResult {
  /** Machine-readable result printed with --json. */
  data: unknown
  /** Human text printed otherwise. */
  text: string
}

class UsageError extends Error {}

function requireArg(value: string | undefined, what: string): string {
  if (!value || !value.trim()) throw new UsageError(`Missing ${what}. Run \`wsc --help\`.`)
  return value
}

function identityOf(flags: Flags, needed = true): Identity {
  const agent = flags.agent ?? process.env.WSC_AGENT ?? ''
  if (needed && !agent) throw new UsageError('No agent identity: pass --agent <ID> or set WSC_AGENT.')
  return { agent, session: flags.session ?? process.env.WSC_SESSION ?? 'cli' }
}

function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(String(value).replace('%', ''))
  if (Number.isNaN(n)) throw new UsageError(`Not a number: ${value}`)
  return n
}

export async function run(argv: string[]): Promise<CliResult | 'stream'> {
  const { values: flags, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  const [command = 'help', sub, ...rest] = positionals
  if (flags.help || command === 'help') return { data: { usage: USAGE }, text: USAGE }

  const cwd = flags.cwd ?? process.cwd()
  // Read-only commands never write: not the registry, not the vault.
  const isReadOnly = command === 'config' || command === 'projects' || command === 'agent-setup' || (command === 'project' && sub !== 'register')
  if (command === 'project' && (sub === 'register' || sub === 'unregister')) return projectCommand(sub, cwd, flags)
  const ws = Workspace.open(cwd, flags.config, flags.agent ?? process.env.WSC_AGENT ?? '', { register: !isReadOnly })
  if (!isReadOnly) ws.init()

  switch (command) {
    case 'init': {
      const { created } = ws.init()
      return {
        data: { workspace: ws.root, created },
        text: `Workspace: ${ws.root}\n${created.length ? `Created:\n${created.map(f => `  ${f}`).join('\n')}` : 'All files already existed.'}`,
      }
    }
    case 'project': {
      const r = ws.resolved
      const data = {
        project: r.project,
        projectRoot: r.projectRoot,
        workspace: r.workspace,
        source: r.workspaceSource,
        registered: r.workspaceSource !== 'registry' || r.registration?.isRegistered === true,
        slug: r.registration?.slug,
      }
      const note = data.registered ? '' : '\n(not registered yet: the first session here, or `wsc project register`, records it)'
      return { data, text: `${r.project} · ${r.workspace} (${r.workspaceSource})${note}` }
    }
    case 'projects': {
      const projects = Object.entries(readRegistry(registryPath()).projects).map(([slug, p]) => ({ slug, ...p }))
      return listing(projects, p => `${p.slug.padEnd(24)} ${p.workspaceDir.padEnd(36)} ${p.roots.join(', ') || '-'}`)
    }
    case 'agent-setup': {
      const tool = requireArg(sub, 'tool (antigravity, cursor, codex, gemini, generic)').toLowerCase()
      const target = AGENT_TARGETS[tool]
      if (!target) throw new UsageError(`Unknown tool ${tool}. One of: ${Object.keys(AGENT_TARGETS).join(', ')}`)
      const id = requireArg(flags.id, '--id (e.g. Antigravity-01)')
      const snippet = agentSetupSnippet(ws.resolved, tool, id)
      if (flags.write) {
        const written = writeAgentSetup(resolvePath(cwd, flags.write), snippet)
        return { data: { ...written, snippet }, text: `Wrote the rule into ${written.file}${written.backup ? ` (previous copy: ${written.backup})` : ''}` }
      }
      return { data: { snippet, where: target.where }, text: `${snippet}\n---\nPut this once in: ${target.where}\nOr run again with --write <file>.` }
    }
    case 'config': {
      if (flags.init) {
        const path = userConfigPath()
        if (existsSync(path)) return { data: { path, written: false }, text: `${path} already exists; not overwritten.` }
        mkdirSync(dirname(path), { recursive: true })
        const { obsidianVault, workspaceDir, projectNotes } = DEFAULT_CONFIG
        writeFileSync(path, JSON.stringify({ obsidianVault, workspaceDir, projectNotes }, null, 2) + '\n')
        return { data: { path, written: true }, text: `Wrote ${path}` }
      }
      const r = ws.resolved
      const data = { project: r.project, projectRoot: r.projectRoot, vault: r.vault, workspace: r.workspace, sources: r.sources, config: r.config }
      return { data, text: JSON.stringify(data, null, 2) }
    }
    case 'snapshot': {
      const snapshot = ws.snapshot()
      return { data: snapshot, text: JSON.stringify(snapshot, null, 2) }
    }
    case 'status': {
      const id = identityOf(flags, false)
      const model = buildDashboard(ws.snapshot(), {
        now: Date.now(),
        self: id.agent,
        staleMinutes: ws.resolved.config.staleAgentMinutes,
        commits: gitLog(ws.resolved.projectRoot, ws.resolved.config.gitLogCount),
      })
      const me = model.agents.find(a => a.isSelf)
      const agent = me ? listAgents(ws).find(a => a.id === me.id) : undefined
      const started = agent?.started ? Date.parse(agent.started) : NaN
      const text = renderTextDashboard(model, {
        width: numberFlag(flags.width) ?? process.stdout.columns ?? 78,
        showGit: !flags['no-git'],
        color: !flags['no-color'] && process.stdout.isTTY === true,
        ...(Number.isNaN(started) ? {} : { elapsedMs: Date.now() - started }),
      })
      return { data: model, text }
    }
    case 'watch': {
      const stop = watchWorkspace(ws.root, gitDir(ws.resolved.projectRoot), event => {
        process.stdout.write(JSON.stringify(event) + '\n')
      })
      const end = () => {
        stop()
        process.exit(0)
      }
      process.on('SIGTERM', end)
      process.on('SIGINT', end)
      // Exit with the parent: once orphaned (reparented), nobody reads us.
      const parent = process.ppid
      setInterval(() => {
        if (process.ppid !== parent) end()
      }, 2_000).unref()
      return 'stream'
    }
    case 'agents':
      return listing(listAgents(ws), a => `${a.id.padEnd(18)} ${a.status.padEnd(10)} ${a.online ? 'online ' : 'offline'} ${a.task}`)
    case 'agent': {
      switch (sub) {
        case 'register': {
          const id = identityOf(flags, false)
          const session = flags.session ?? process.env.WSC_SESSION ?? newSessionId()
          const result = registerAgent(ws, {
            ...(flags.id ?? (id.agent || undefined) ? { id: flags.id ?? id.agent } : {}),
            ...(flags.prefix ? { prefix: flags.prefix } : {}),
            ...(flags.kind ? { kind: flags.kind } : {}),
            ...(flags.branch ? { branch: flags.branch } : {}),
            session,
            cwd,
          })
          const reaped = reapStaleAgents(ws, { agent: result.agent.id, session })
          return {
            data: { ...result, reaped, workspace: ws.root, project: ws.project, files: ws.resolved.files, config: ws.resolved.config },
            text: `${result.resumed ? 'Resumed' : 'Registered'} ${result.agent.id} (session ${session})\nWorkspace: ${ws.root}\nexport WSC_AGENT=${result.agent.id} WSC_SESSION=${session}`,
          }
        }
        case 'status': {
          const agent = setAgentStatus(ws, identityOf(flags), requireArg(rest[0], 'status'), {
            ...(flags.task !== undefined ? { task: flags.task.join(' ') } : {}),
            ...(flags.state !== undefined ? { workingState: flags.state } : {}),
          })
          return { data: agent, text: `${agent.id} is ${agent.status}` }
        }
        case 'heartbeat': {
          const identity = identityOf(flags)
          const agent = heartbeat(ws, identity, flags.state)
          const reaped = reapStaleAgents(ws, identity)
          return { data: { ...agent, reaped }, text: `${agent.id} active at ${agent.lastActivity}` }
        }
        case 'reap': {
          const identity = identityOf(flags, false)
          const reaped = reapStaleAgents(ws, { ...identity, agent: identity.agent || 'external' })
          return { data: { reaped }, text: reaped.length ? `Marked offline: ${reaped.join(', ')}` : 'No stale agents' }
        }
        case 'end': {
          const agent = endSession(ws, identityOf(flags), flags.reason ?? 'ended')
          return { data: agent, text: `${agent.id} session ended` }
        }
        case 'list':
        case undefined:
          return run(['agents', ...argv.filter(a => a !== 'agent' && a !== 'list')])
        default:
          throw new UsageError(`Unknown agent subcommand: ${sub}`)
      }
    }
    case 'plan': {
      if (sub === 'show' || sub === undefined) {
        const text = readText(ws.path('plan'))
        return { data: { path: ws.path('plan'), text }, text }
      }
      if (sub !== 'create') throw new UsageError(`Unknown plan subcommand: ${sub}`)
      const result = createPlan(ws, identityOf(flags), {
        objective: requireArg(flags.objective ?? rest.join(' '), '--objective'),
        tasks: flags.task ?? [],
        assignments: flags.assign ?? [],
        dependencies: flags.dep ?? [],
        ...(flags.note ? { notes: flags.note } : {}),
      })
      return {
        data: result,
        text: `Plan written to ${result.path}${result.archived ? ` (previous plan archived to ${result.archived})` : ''}\n${result.tasks.map(t => `  ${t.id} ${t.title}`).join('\n')}`,
      }
    }
    case 'tasks':
      return listing(listTasks(ws), t => `${t.id.padEnd(9)} ${t.status.padEnd(11)} ${(t.owner || '-').padEnd(16)} ${t.title}`)
    case 'task': {
      const identity = identityOf(flags)
      switch (sub) {
        case 'add': {
          const { task, created } = addTask(ws, identity, requireArg(rest.join(' '), 'task title'), { depends: flags.depends ?? [] })
          return { data: { task, created }, text: created ? `Created ${task.id} ${task.title}` : `Already exists: ${task.id} ${task.title} (${task.status})` }
        }
        case 'claim': {
          const result = claimTask(ws, identity, requireArg(rest[0], 'task id'), { force: flags.force === true })
          const warn = result.unmetDependencies.length ? `\nWarning: depends on unfinished ${result.unmetDependencies.join(', ')}` : ''
          return { data: result, text: `${identity.agent} claimed ${result.task.id} ${result.task.title}${warn}` }
        }
        case 'release': {
          const task = releaseTask(ws, identity, requireArg(rest[0], 'task id'), { force: flags.force === true, ...(flags.note ? { note: flags.note } : {}) })
          return { data: task, text: `Released ${task.id}` }
        }
        case 'status': {
          const progress = numberFlag(flags.progress)
          const task = setTaskStatus(ws, identity, requireArg(rest[0], 'task id'), requireArg(rest[1], 'status'), {
            force: flags.force === true,
            ...(progress === undefined ? {} : { progress }),
            ...(flags.note ? { note: flags.note } : {}),
          })
          return { data: task, text: `${task.id} is ${task.status}` }
        }
        case 'done': {
          const task = completeTask(ws, identity, requireArg(rest[0], 'task id'), { force: flags.force === true, ...(flags.note ? { note: flags.note } : {}) })
          return { data: task, text: `${task.id} DONE` }
        }
        case 'list':
          return run(['tasks', ...(flags.json ? ['--json'] : [])])
        default:
          throw new UsageError(`Unknown task subcommand: ${sub ?? ''}`)
      }
    }
    case 'msg': {
      if (sub === 'send') {
        const message = sendMessage(ws, identityOf(flags), requireArg(flags.to, '--to'), requireArg(rest.join(' '), 'message body'))
        return { data: message, text: `Sent ${message.id} to ${message.to}` }
      }
      const messages = sub === 'inbox' ? inbox(listMessages(ws), identityOf(flags).agent, flags.after) : listMessages(ws)
      return listing(messages, m => `${m.id.padEnd(8)} ${m.from} → ${m.to}  ${m.body.replace(/\s+/g, ' ').slice(0, 80)}`)
    }
    case 'requests': {
      const requests = listRequests(ws).filter(r => !flags.open || r.status === 'OPEN')
      return listing(requests, r => `${r.id.padEnd(12)} ${r.status.padEnd(9)} ${r.priority.padEnd(7)} ${r.from} → ${r.to}  ${r.title}`)
    }
    case 'request': {
      const identity = identityOf(flags)
      switch (sub) {
        case 'create': {
          const request = createRequest(ws, identity, {
            to: requireArg(flags.to, '--to'),
            question: requireArg(rest.join(' '), 'question'),
            ...(flags.title ? { title: flags.title } : {}),
            ...(flags.priority ? { priority: flags.priority } : {}),
          })
          return { data: request, text: `Created ${request.id} → ${request.to}` }
        }
        case 'answer': {
          const request = answerRequest(ws, identity, requireArg(rest[0], 'request id'), requireArg(rest.slice(1).join(' '), 'answer'), { close: flags.close === true })
          return { data: request, text: `Answered ${request.id} (${request.status})` }
        }
        case 'close': {
          const request = closeRequest(ws, identity, requireArg(rest[0], 'request id'))
          return { data: request, text: `Closed ${request.id}` }
        }
        case 'list':
          return run(['requests', ...(flags.open ? ['--open'] : []), ...(flags.json ? ['--json'] : [])])
        default:
          throw new UsageError(`Unknown request subcommand: ${sub ?? ''}`)
      }
    }
    case 'milestone': {
      const title = requireArg([sub, ...rest].filter(Boolean).join(' '), 'milestone title')
      const milestone = addMilestone(ws, identityOf(flags), title, flags.note ?? '')
      return { data: milestone, text: `Milestone ${milestone.id}: ${milestone.title}` }
    }
    case 'git': {
      const commits = gitLog(ws.resolved.projectRoot, numberFlag(flags.count) ?? ws.resolved.config.gitLogCount)
      return listing(commits, c => `${c.hash}  ${c.subject}`)
    }
    case 'commit': {
      if (sub === 'record') {
        const record = recordCommit(ws, identityOf(flags), flags.rev ?? 'HEAD')
        return { data: record ?? null, text: record ? `Recorded ${record.hash} ${record.subject}` : 'Nothing to record (already recorded or no commit).' }
      }
      if (sub === 'sync') {
        const identity = identityOf(flags, false)
        const records = syncCommits(ws, { agent: 'external', session: identity.session })
        return { data: records, text: records.length ? records.map(r => `Recorded ${r.hash} ${r.subject}`).join('\n') : 'Up to date.' }
      }
      throw new UsageError(`Unknown commit subcommand: ${sub ?? ''}`)
    }
    default:
      throw new UsageError(`Unknown command: ${command}. Run \`wsc --help\`.`)
  }
}

function listing<T>(items: T[], line: (item: T) => string): CliResult {
  return { data: items, text: items.length ? items.map(line).join('\n') : '(none)' }
}

export function isUsageError(error: unknown): boolean {
  return error instanceof UsageError || (error as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS') === true
}

export function isCoordinationError(error: unknown): error is CoordinationError {
  return error instanceof CoordinationError
}

function resolvePath(cwd: string, path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  return resolve(cwd, expanded)
}

/** `project register` / `project unregister`: explicit changes to projects.json. */
function projectCommand(sub: 'register' | 'unregister', cwd: string, flags: Flags): CliResult {
  const resolved = loadConfig(cwd, flags.config)
  const path = registryPath()
  const root = resolved.projectRoot
  if (sub === 'unregister') {
    const match = unlinkRoot(path, root)
    return {
      data: match ?? null,
      text: match ? `Detached ${root} from ${match.slug}; its notes in ${match.entry.workspaceDir} are kept.` : `${root} is not registered.`,
    }
  }
  if (resolved.workspaceSource !== 'registry') {
    throw new UsageError(`${root} is pinned to ${resolved.workspace} by ${resolved.workspaceSource === 'env' ? 'WSC_WORKSPACE_DIR' : 'a workspaceDir in a project config file'}; remove that to use the registry.`)
  }
  const registry = readRegistry(path)
  const own = Object.entries(registry.projects).find(([, p]) => p.roots.includes(root))
  if (own && !flags.name) return { data: { slug: own[0], ...own[1] }, text: `Already registered: ${own[0]} · ${own[1].workspaceDir}` }
  if (own) unlinkRoot(path, root)
  const named = flags.name ? Object.entries(registry.projects).find(([slug, p]) => slug === flags.name || p.name === flags.name) : undefined
  const proposed = named
    ? { slug: named[0], entry: named[1], isRegistered: true }
    : proposeProject(readRegistry(path), root, resolved.config.workspaceDir, flags.name)
  const saved = saveProject(path, root, proposed, resolved.config.workspaceDir)
  Workspace.open(cwd, flags.config).init()
  return {
    data: { slug: saved.slug, ...saved.entry },
    text: `${named ? 'Joined' : 'Registered'} ${root} → ${saved.slug} · ${saved.entry.workspaceDir}`,
  }
}
