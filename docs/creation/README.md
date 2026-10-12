# How Workspace Commander was built

Workspace Commander was built by several Claude Code sessions working on the same code at the same time. They coordinated through Workspace Commander itself: a shared plan, task claims, messages, and requests, all kept as Markdown in an Obsidian vault.

This folder keeps that record:

- **This file:** the timeline, the decisions, and how each step was verified.
- **[`workspace/`](workspace/):** a snapshot of the project's real coordination notes, copied unchanged from the vault on 2026-10-12. Open the folder in Obsidian to browse it as a vault.

| File | What it shows |
| --- | --- |
| [`PLAN.md`](workspace/PLAN.md) | The shared plan: a reliability pass, written by Claude-02 |
| [`TASKS.md`](workspace/TASKS.md) | TASK-001 to TASK-006, with owners, status, and timestamps |
| [`MESSAGES.md`](workspace/MESSAGES.md) | Messages between agents, including the file-ownership agreement |
| [`REQUESTS.md`](workspace/REQUESTS.md) | REQUEST-001: the handoff of shared files from Claude-02 to Claude-04 |
| [`SESSION_LOG.md`](workspace/SESSION_LOG.md) | Every event, with machine-readable `WC_EVENT` blocks |
| [`AGENTS.md`](workspace/AGENTS.md), [`SESSIONS/`](workspace/SESSIONS/) | Each agent's state and session journal |

The notes are unedited, so they still contain the authors' local paths and session IDs. The plan's title reads "Current Plan · tehsaad" because it was written before projects had their own workspace folders. That bug was fixed in 0.2.0 (see below).

## Timeline

### 0.1.0 · 2026-10-08: the first version

A Claude Code mod plus the `wsc` CLI:
- the dashboard pane and `/togglegit`
- the agent tools (`task_claim`, `request_create`, and the rest)
- native file watching, locked and atomic Markdown writes
- [`AGENT_PROTOCOL.md`](../../AGENT_PROTOCOL.md), so that any AI agent can join by editing files

All projects shared one workspace folder.

### 2026-10-09 morning: two agents on one codebase

| Time | Event |
| --- | --- |
| 10:33 | **Claude-02** writes the plan "Reliability pass on Workspace Commander" with TASK-001 to TASK-004 and claims TASK-001: mark stale agents offline. |
| 10:34 | **Claude-04** is asked to make coordination persistent and automatic across sessions. It adds and claims TASK-005, then messages Claude-02 with the exact files it will edit and the ones it will leave alone (MSG-001). |
| 10:35 | Claude-02 was editing `hooks/register.tsx`, `src/commands/run.ts`, and the integration tests at that moment. Claude-04 stays out of those three files and asks for a handoff with REQUEST-001 (HIGH). |
| 10:41 | Claude-02 finishes the stale-agent reaper and the idle heartbeat, answers REQUEST-001, and hands over the three files. |
| 10:42 | Claude-02 completes TASK-002 (Git panel verified in a real repository). |
| 10:52 | Claude-04 completes TASK-005 and ships 0.2.1. |

### 0.2.0 / 0.2.1 · TASK-005: persistent multi-session coordination

Problems found while auditing the 0.1.0 code:

1. **No project isolation.** Every directory resolved to the same workspace folder. A session started in the home directory wrote the shared plan, which is why it is titled "· tehsaad".
2. **Read items could be lost.** On an agent ID's first run, everything already in the workspace was marked read without being shown.
3. **One conversation registered twice.** The process continued under a new session ID and got a second agent ID; Claude-04 itself also appeared as a "Claude-01" ghost.
4. **The installed plugin was a copy, not a link** (the docs said otherwise), so source edits never reached new sessions.

What was built:

- **Project registry** (`~/.config/workspace-commander/projects.json`). Each project gets its own folder. Git worktrees share their main repository's project. `PROJECTS.md` lets agents without the CLI find their folder.
  - The existing folder was migrated by registering its three known roots, so live sessions kept their workspace.
- **Startup briefing.** The first prompt of a session says who is online and lists the open tasks, the open requests, and unread items.
- **Read state** advances only after an item has been delivered to the model. It is kept per workspace and agent; the per-workspace key came from a bug caught in the fresh-session test, where one project's state hid another project's messages.
- **New notices:**
  - when another agent takes over your task;
  - delivered in the results of the agent tools too, so a busy session doesn't wait for the next prompt.
- **Agent ID kept** when the same process continues under a new session ID.
- **`wsc project` / `projects` / `project register` / `project unregister`** commands.
- **`wsc agent-setup`.** Configure Antigravity, Cursor, Codex, or Gemini once with a standing rule instead of repeating the instructions in every chat.
- **Never overwrite:**
  - the generated protocol copy is backed up before it is refreshed;
  - `--write` replaces only its marked block, after making a backup;
  - an invalid registry is reported and never replaced.

Verification:
- **Unit and integration tests:** 36/36 CLI and 9/9 mod.
- **New headless `claude -p` sessions:** one in an isolated vault and one against the real vault. Each found the config and the shared workspace on its own, and reported its agent ID, project, tasks, messages, and requests.

### 0.3.0 · 2026-10-09 afternoon · TASK-006: the web dashboard

A separate local web application in [`dashboard/`](../../dashboard/), alongside Obsidian, and reading the same Markdown files.

- **Server:** Node with no dependencies, at 127.0.0.1 only. Every write calls the same library as `wsc` and the agent tools (locks, atomic writes, duplicate-task check, refusal of tasks owned by another online agent). Changes are pushed to the browser through native file watching and Server-Sent Events.
- **Security:** a token for each server run, Host and Origin checks, and a strict Content-Security-Policy.
- **Interface:** plain HTML, CSS, and JavaScript with no build step. It has:
  - an overview, a Kanban board with drag and drop, and an agent monitor;
  - messages and requests, the plan and milestones, and an activity feed;
  - Git history and a ⌘K command palette;
  - a layout that adapts down to phone width.
- **Verification:**
  - 10 server tests: security, reads, writes landing in Markdown, refusals, live synchronization of Obsidian edits and new commits;
  - headless Chrome over the DevTools protocol, run against a throwaway vault: board actions, the refusal with its override, search, the phone layout, and an external edit appearing in an open page without a reload.
- **Not possible with the mod API:** a full GUI inside Claude Code (mods draw only text and buttons in a pane), and linking the dashboard's Git switch to `/togglegit` (that state lives in Claude Code's private plugin storage). The dashboard became the full interface; the pane remains a compact status view.

### 2026-10-11: published

The source was committed for the first time and pushed to GitHub with all tests passing (46/46 Node, 9/9 mod). The initial commit already on GitHub (README tagline and license) was merged in rather than overwritten.

## Lessons from building it this way

- **Announce file ownership before editing.** MSG-001 listed every file Claude-04 would touch. The shared files waited for an explicit handoff (REQUEST-001) instead of being edited by two agents at once.
- **Check modification times.** A file changed in the last minute means another agent is in it.
- **Test the way users start it.** The per-workspace read-state bug only showed up in a fresh `claude -p` session, not in unit tests.
- **Leave other agents' work intact.** Claude-02's heartbeat and reaper were kept through every later edit of the same files.

## Still open

- TASK-003: document the development versus installed workflow.
- TASK-004: cross-session and Antigravity interoperability test.
