# Workspace Commander

> Trying to build a Jarvis (local).

Workspace Commander is a local multi-agent command center. Several AI coding agents (Claude Code sessions, Gemini CLI, Google Antigravity, OpenAI Codex, Cursor, or any tool that can read and write files) coordinate on one project through plain Markdown in an Obsidian vault. They share a plan, own tasks, send messages, and ask each other questions.

Claude Code joins through its plugin; MCP-capable tools through `wsc mcp`, a local MCP server with the same tools; anything else by following the Markdown protocol. Which tools are verified live, and how to set each one up: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

How it was built, by several Claude Code sessions coordinating through Workspace Commander itself: [`docs/creation/`](docs/creation/README.md).

Working on the code: [`CLAUDE.md`](CLAUDE.md) (layout, commands, dev vs installed, rules). Open work and proposals: [`docs/ROADMAP.md`](docs/ROADMAP.md).

No agent needs Workspace Commander installed or a direct API to another agent. The Markdown files *are* the protocol: [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md).

```
Claude Code ──writes──▶ Obsidian Markdown ◀──reads/writes── Antigravity / any AI / you
     ▲                    PLAN · TASKS · AGENTS · REQUESTS · MESSAGES …
     └── native file watching: answers and messages arrive in the session
```

## What maps to what (real Claude Code APIs)

Workspace Commander is a Claude Code **mod**: a plugin of function hooks (`hooks/register.tsx`) that runs inside Claude Code's hooks sandbox. The sandbox has no Node and no DOM, so the Node part is a separate CLI (`wsc`) that the mod calls.

| Requested | Implemented with |
| --- | --- |
| Dashboard UI | A docked **Pane** (`$.ui.open` + a `ui.render` hook on `Pane`), drawn with the surface's own `Box`/`Text`/`Button`, so it uses your theme. Works in the terminal and the desktop app. |
| `/togglegit` | `$.command.register` + a `command.run` hook. The pane's **[ Hide Git ]** button calls the same function on the same `$.state` value, which is mirrored to `$.store` so it survives restarts. |
| Agent tools | `$.tool.register`: `workspace_status`, `plan_create`, `task_add`, `task_claim`, `task_update`, `task_complete`, `task_release`, `message_send`, `request_create`, `request_answer`, `request_close`, `milestone`, `agent_status`, `context_note` (listed as `mcp__workspace-commander__*`). The same definitions are served to other tools by `wsc mcp` ([`src/coordination/tools.ts`](src/coordination/tools.ts)). |
| Agent awareness | A `prompt.compose` hook adds the agent's ID, the workspace path, and the coordination rules to the system prompt. |
| Session lifecycle | `session.start` loads the config, resolves the project, and registers the agent (a unique `Claude-NN` per online session; restart, hot reload, and a session-id change in the same process keep the same ID). `session.end` marks it offline. |
| Startup briefing | On connect, the session reads `AGENTS.md`, `TASKS.md`, `REQUESTS.md`, and `MESSAGES.md`. The first prompt carries a briefing: who is online, the open tasks, open requests for this agent, and its unread messages and answers. |
| Project isolation | Each project gets its own workspace folder, recorded once in `~/.config/workspace-commander/projects.json` (see [Projects](#projects)). Sessions in the same repository (or its worktrees) share it, and other projects never see it. |
| Commit tracking | A `tool.call` hook on `Bash` records `git commit`s. Commits made outside any agent are recorded as `external` by `wsc commit sync`. |
| File watching | **Requested API unavailable:** the hooks sandbox's `$.fs` has no watch. **Closest supported mechanism:** `$.process.spawn` of `wsc watch`, which uses Node's native `fs.watch` (inotify / FSEvents) on the workspace and on `.git`, debounced. If that child cannot start, the mod falls back to `$.fs.stat` mtime polling every 2 s (no processes). |
| Atomic writes and locking | **Requested API unavailable:** `$.fs` has no append, rename, or exclusive create. **Closest supported mechanism:** every write goes through the `wsc` CLI (`$.process.run`), which does O_EXCL lock files, temp file + fsync + rename, and O_APPEND event streams. |
| Live git log | `git log --oneline -n 5` runs only when the watcher reports a change under `.git` (HEAD, refs, reflog), never on a timer. |
| Hot reload | **Supported natively.** Claude Code watches `--plugin-dir` folders (and `CLAUDE_CODE_PLUGIN_DIRS` folders with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`) and reloads the hooks module on save. `npm run dev` rebuilds the CLI on save. See [Development](#development--hot-reload). |
| Wake on answer | When a message, request, or answer addressed to this agent arrives, or another agent takes over a task it owns, while the session is idle, `$.prompt.submit` starts a turn (`autoWake`, on by default). Otherwise the item is attached to your next prompt as context. An item counts as read only once it has been handed to the model, so nothing is marked read unseen. |

## Files

```
workspace-commander/                    ← the plugin folder (load this)
├── .claude-plugin/plugin.json          mod manifest (+ marketplace.json for installing)
├── hooks/hooks.json, register.tsx      the mod: every $ call lives here (an engine rule)
├── types/index.d.ts                    the mod's $.state contract
├── src/
│   ├── types.ts                        Agent, Session, Task, Message, Request, Milestone, GitCommit, WorkspaceEvent, Config
│   ├── config/                         defaults + loader (user, project, env)
│   ├── filesystem/                     locks, atomic writes, appends, native watcher
│   ├── events/                         WC_EVENT format, ids, timestamps
│   ├── obsidian/                       Markdown record format, parsers, workspace layout, ProjectNotes
│   ├── agents/                         register, status, heartbeat, end, reaper; adapters.ts (one entry per AI tool)
│   ├── coordination/                   plan, tasks (claiming), messages, requests, milestones,
│   │                                   context (an agent's briefing), tools (shared tool specs), validate
│   ├── mcp/                            wsc mcp: the stdio MCP server for other AI tools
│   ├── git/                            log, commit record, external sync
│   ├── dashboard/                      view model + text renderer (shared by pane and CLI)
│   ├── commands/                       wsc CLI commands
│   ├── mod/                            pure helpers for the mod (pane tree, tools, inbox)
│   ├── cli.ts                          wsc entry
│   └── index.ts                        library exports
├── test/integration.test.mjs           real processes, real files (npm test)
├── test/multiagent.test.mjs            regressions + multi-agent acceptance tests over MCP and the CLI (npm test)
├── test/acceptance/live-agents.sh      the real Claude Code, Codex, Antigravity, Gemini CLI (npm run test:live)
├── test/mod/mod.test.tsx               mod tests in Claude Code's own host (claude plugin test .)
├── dashboard/test/                     dashboard server tests (npm test) and browser tests (npm run test:ui)
├── docs/INTEGRATIONS.md                adapters, per-tool setup, what is verified
├── AGENT_PROTOCOL.md                   the protocol any AI follows
└── install.sh
```

The vault layout, created on first use:

```
<vault>/WorkspaceCommander/
├── PROJECTS.md                    which repository uses which folder (generated block)
└── my-app/                        one folder per project
    ├── ProjectNotes.md   AGENTS.md   PLAN.md   TASKS.md   MESSAGES.md   REQUESTS.md
    ├── MILESTONES.md     COMMITS.md  SESSION_LOG.md       AGENT_PROTOCOL.md
    ├── SESSIONS/Claude-01.md …    (one journal per agent)
    ├── PLANS/                     (archived plans)
    └── .wc/                       (locks, sync state, backups; hidden from Obsidian)
```

## Installation

Prerequisites: Node.js 20.11 or newer, npm, git, Claude Code 2.1.29x or newer, and optionally Obsidian.

```bash
cd ~/Desktop/workspace-commander
./install.sh
```

The installer checks Node, npm, and git, then builds. It writes `~/.config/workspace-commander/config.json` (only if absent, unless you confirm), creates the vault folder, links `wsc` into `~/.local/bin`, validates the mod, and offers to register it with Claude Code. Run `./install.sh --help` for flags (`--vault`, `--yes`, `--no-claude`, …).

Manual equivalent:

```bash
npm install && npm run build
claude plugin marketplace add ~/Desktop/workspace-commander
claude plugin install workspace-commander@workspace-commander
```

Installed this way, Claude Code runs a **copy** of this folder from `~/.claude/plugins/cache/`. After changing the source, bump `version` in `package.json` and `.claude-plugin/plugin.json`, then update the copy and start a new session:

```bash
claude plugin marketplace update workspace-commander
claude plugin update workspace-commander@workspace-commander
```

To run the source folder directly while developing, use `--plugin-dir` (below).

## Start

```bash
cd ~/path/to/your-project
claude
```

The dashboard pane opens on its own where there is room (a fullscreen terminal 144+ columns wide, or the desktop app). Otherwise type `/wc`. `/wc status` prints the board inline. External agents only need the workspace path and `AGENT_PROTOCOL.md`.

Without installing, for one session: `claude --plugin-dir ~/Desktop/workspace-commander`.

## Dashboard (browser)

A local web app over the same vault, in `dashboard/`. Obsidian and the dashboard are two independent views of the same Markdown files. Neither needs the other running, and nothing is stored anywhere else.

```bash
cd ~/Desktop/workspace-commander
npm run dashboard                       # http://127.0.0.1:4777
node dashboard/server.mjs --port 4800 --as Saad --open   # other port, your own agent ID, open the browser
```

Stop it with **Ctrl+C** in that terminal. If it runs in the background, use `pkill -f dashboard/server.mjs`.

| Option | Default | |
| --- | --- | --- |
| `--port` | `4777` (`WC_DASHBOARD_PORT`) | `0` picks a free port |
| `--host` | `127.0.0.1` | Loopback only. Another host exposes your vault to the network. |
| `--as` | `Human-01` (`WC_DASHBOARD_AS`) | Your agent ID for writes, also changeable in Settings |
| `--project` | the current directory's project | Every registered project is in the switcher |

What it shows: an overview (shared session timer, task counts, agents, activity per hour), a Kanban board (Pending, In Progress, In Review, Completed, Blocked) with drag and drop, the agent monitor, messages and requests with answers, the plan and milestones, a live activity feed, the last five commits, search with a command palette (⌘K or Ctrl+K), filters, and settings.

How it stays in sync:
- **Reads** parse the Markdown files on every refresh. A native watcher (inotify or FSEvents) on the project folder and `.git` pushes changes to the browser over Server-Sent Events. Edits in Obsidian, by Claude sessions, by Antigravity, or with `wsc` appear within about a second.
- **Writes** call the same library functions as `wsc` and the Claude tools: file locks, temp file plus rename, one event per action, the duplicate-title check for tasks, and claim refusal when another online agent owns a task (the UI offers an explicit override). You appear in `AGENTS.md` as an agent of kind `human`.
- **Safety:** the server binds to 127.0.0.1, answers only to loopback Host names, requires a per-run token embedded in the page, rejects cross-origin writes, and sends a strict Content-Security-Policy. It has no dependencies.

Live without any Claude Code session: everything in the dashboard (all reads, all writes, file watching, Git history, every project). It needs a running Claude session only for things that happen inside that session: the agent picking up your message or answer (it is woken or briefed by the plugin), its heartbeat, and its own `/togglegit` pane state. An agent shows as online only while its session keeps `Last Activity` fresh.

The dashboard's **Hide/Show Git** switch is its own preference (kept in the browser). `/togglegit` still controls the Claude Code pane. The pane state lives in Claude Code's plugin store, which a separate process cannot read or write, so the two are not linked.

### The Claude Code pane

The in-session pane (`/wc`) remains, unchanged. Mods draw only with the surface's own primitives (`Box`, `Text`, `Button`, inside a pane or band in the terminal or desktop app). There is no HTML, CSS, routing, drag and drop, or charting in the mod UI API, so a full application such as the dashboard cannot be rendered inside Claude Code. The browser dashboard is that full interface, and the pane stays a compact status view.

## Development / hot reload

```bash
cd ~/Desktop/workspace-commander
npm run dev                                               # terminal 1: rebuilds dist/ (the wsc CLI) on save
claude --plugin-dir ~/Desktop/workspace-commander         # terminal 2: Claude Code reloads the mod on save
```

- Editing `hooks/` or `src/mod/` reloads the mod in the running session: no build step, because the engine compiles TypeScript itself. `$.state` (dashboard, timer, Git visibility) survives the reload.
- Editing anything else under `src/` triggers a rebuild by `npm run dev`. The next `wsc` call uses the new code. The rewrite of `dist/` also reloads the mod, which restarts the watcher child.
- For a session started by the desktop app, set this in `~/.claude/settings.json` and restart the app:
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Desktop/workspace-commander", "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1" } }
  ```
- Only a change to `.claude-plugin/plugin.json` needs a new session. A plugin installed through the marketplace reloads with `/reload-plugins`.

Checks:

```bash
npm test                      # build + CLI integration tests + dashboard server tests (real processes, files, git)
claude plugin validate .      # what the engine sees and would refuse
claude plugin test .          # mod tests in Claude Code's own host (terminal + desktop surfaces)
npm run typecheck             # CLI + mod (the mod's types appear in .claude-plugin/types/ after its first load)
```

## Configure Obsidian

`~/.config/workspace-commander/config.json`:

```json
{
  "obsidianVault": "~/Documents/Obsidian",
  "workspaceDir": "WorkspaceCommander",
  "projectNotes": "ProjectNotes.md"
}
```

- `obsidianVault` is your vault folder. In Obsidian, use **Open folder as vault** on it.
- `workspaceDir` is the folder inside the vault that holds the per-project folders (see [Projects](#projects)). A `<repo>/.workspace-commander.json` with its own `workspaceDir` pins that repository to exactly that folder instead.
- `projectNotes` is the project notes file inside that folder.
- Optional keys: `project` (display name; defaults to the repo folder name), `agentPrefix` (`Claude`), `staleAgentMinutes` (30), `gitLogCount` (5), `autoWake` (true), `lockStaleMs` (10000), and `files` (rename any file, e.g. `{ "tasks": "Tasks.md" }`).
- Environment overrides: `WSC_VAULT`, `WSC_WORKSPACE_DIR`, `WSC_CONFIG`. `WSC_AGENT` pins this session's agent ID. `WSC_NODE` sets the Node binary if `node` is not on Claude Code's PATH.

Check the resolved paths with `wsc config`.

This file is the only place the vault path is set. Every new Claude Code session, in any directory, loads it through the plugin's `session.start` hook. Nothing is configured per session.

## Projects

The first session in a repository registers it: an entry in `~/.config/workspace-commander/projects.json` maps the repository to `<workspaceDir>/<name>`, and `PROJECTS.md` lists it for agents without the CLI. Later sessions in that repository, or in any of its git worktrees, resolve to the same folder and see each other's tasks, messages, and requests. Sessions in other repositories get their own folders and never see them.

- A directory outside git is a project of its own, unless it sits inside a registered root or a project's workspace folder. (The home directory never counts as an enclosing root.)
- `wsc project` shows what the current directory resolves to, and `wsc projects` lists all projects.
- `wsc project register --name <existing>` joins another repository to an existing project, so the two share one workspace. `--name <new>` registers under a name of your choosing.
- `wsc project unregister` detaches the current repository. Its notes stay where they are.
- Precedence: `WSC_WORKSPACE_DIR` > a `workspaceDir` in `<repo>/.workspace-commander.json` or `--config` > `projects.json` > a new registration.

Workspace Commander never overwrites a note. New files are created exclusively, and records are edited one field or section at a time. Generated blocks sit between `wc:` markers. When the generated `AGENT_PROTOCOL.md` is refreshed, the previous copy goes to `.wc/backups/` first. `projects.json` is only merged into under a lock, and an unreadable one is reported, never replaced.

## Verify `/togglegit`

1. Type `/wc` to open the dashboard. Recent commits appear under **GIT**, with **[ Hide Git ]**.
2. Type `/togglegit`. The output reads `Git panel: HIDDEN`, the commits disappear, and the button reads **[ Show Git ]**.
3. Press the button (click it, or press `g` while the pane has focus). The commits return, and the next `/togglegit` says `HIDDEN` again. Both controls change one state.
4. Make a commit. The GIT list updates within a second, with no refresh.

## Other AI tools (Gemini CLI, Antigravity, Codex, Cursor, …)

Configure each tool **once**, not per chat. `wsc agent-setup` prints a standing rule with the tool's fixed agent ID and the MCP server entry that gives it the coordination tools, both with absolute paths:

```bash
wsc adapters                                                     # what is installed, supported and verified here
wsc agent-setup gemini                                           # rule + MCP entry for Gemini CLI (id Gemini-01)
wsc agent-setup antigravity --write ~/.gemini/GEMINI.md           # write the rule (backed up, only its block changes)
wsc agent-setup codex --id Codex-01                              # prints `codex mcp add workspace-commander -- …`
```

With the MCP entry, the tool's agent registers on its own, calls `workspace_status` for its briefing (its open tasks first, after a restart too), claims with `task_claim`, waits for answers with `request_wait`, and is marked offline when the tool exits. Without MCP, the rule tells it to follow [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md): it registers by adding a section to `AGENTS.md`, claims by editing `TASKS.md`, and answers by appending `### Answer — <ID> · <time>` to `REQUESTS.md`. Claude sessions pick up each change within a second.

Per-tool steps, manual configuration, and which tools were verified live: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Upgrade

```bash
cd ~/Desktop/workspace-commander
git pull
./install.sh --yes            # rebuilds; keeps your config; re-registers the plugin
claude plugin marketplace update workspace-commander
claude plugin update workspace-commander@workspace-commander
```

Then restart Claude Code sessions (a session keeps the plugin copy it started with) and restart other tools so they start the new `wsc mcp`. The Markdown format is backward compatible: 0.4 reads every 0.3 workspace, and the new `Capabilities` and `Process` fields are optional.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| A change to the source has no effect in Claude Code | Sessions run the installed copy. Bump `version` in `package.json` and `.claude-plugin/plugin.json`, run the two `claude plugin … update` commands above, restart the session. Or develop with `claude --plugin-dir .`. |
| `workspace_status` in another tool shows the wrong project | The tool started `wsc mcp` outside the repository and reported no roots. Add `--cwd <repo>` to the server arguments. |
| Codex says "MCP tool call requires approval" | `codex exec` cannot ask. Add `default_tools_approval_mode = "approve"` to `[mcp_servers.workspace-commander]`, or use Codex interactively. |
| `agy -p` stops at "Authentication required" | Sign in once interactively: run `agy`. |
| An agent stays "online" after its tool crashed | It is marked offline 30 minutes (`staleAgentMinutes`) after its last activity, when any agent registers or heartbeats; `wsc agent reap` does it now. Its tasks can be taken over with `task claim` once it is offline. An MCP agent that restarts with the same `--agent` gets its id and tasks back at once. |
| `Refused: TASK-… is owned by …` | Another online agent owns the task. Message it or pick another task; `--force` only after it agreed. |
| `Timed out waiting for the lock on …` | A process held a workspace lock for 15 s. Locks of crashed processes on this machine are taken over at once and any lock after `lockStaleMs` (10 s); a timeout means a live process is stuck. Check `.wc/locks/` in the workspace folder. |
| `Invalid file name for files.…` or `sets workspaceDir … outside the vault` | A config file points outside the workspace. A repository may only pin a folder inside the vault; set other folders in your user config or `WSC_WORKSPACE_DIR`. |
| The dashboard says "Lost contact with the dashboard server" | The server stopped. Start it again (`npm run dashboard`); an open page reconnects and reloads itself to pick up the new token. |

## Uninstall

```bash
./install.sh --uninstall
```

It removes the Claude Code plugin and the `wsc` link it created, and lists what it keeps: your config and `projects.json`, the workspaces in your vault, and other tools' MCP entries and rules (with the command to remove each).

## Tests

```bash
npm test                 # build + CLI, multi-agent and dashboard server tests (real processes, files, git)
npm run test:mod         # claude plugin validate . && claude plugin test . (mod tests in Claude Code's host)
npm run test:ui          # dashboard in headless Chrome (skipped without Chrome; CHROME=/path to choose)
npm run typecheck        # CLI + mod (the mod's types appear in .claude-plugin/types/ after its first load)
npm run test:live -- claude codex antigravity gemini   # the real tools; spends model usage; opt-in
```
