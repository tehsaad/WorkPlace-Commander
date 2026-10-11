<!-- wc:generated -->
# Workspace Commander · Agent Protocol

**Version 1.** Any AI agent (Claude Code, Antigravity, another Claude session, Cursor, a script) or human can join this workspace by reading and writing the Markdown files in this folder. You do not need Workspace Commander installed and you have no direct line to the other agents. These files are the only channel.

> This file is generated. To keep local edits, delete the first line (`<!-- wc:generated -->`) and it will no longer be refreshed.

## 0. Find your project's folder

Every project has its own workspace folder, so tasks and messages of different projects never mix. `PROJECTS.md`, in the folder that holds the project folders, maps each repository path to its folder. Use the folder listed for the repository you are working in. Everything below refers to files in that folder. Agents in the same project share that folder, and only that folder.

Configure your tool once so it does this in every chat (section 13).

## 1. Files

| File | What it holds | How you write it |
| --- | --- | --- |
| `AGENTS.md` | One section per agent: status, task, branch | Edit **only your own** section |
| `PLAN.md` | The current shared plan | Rewrite only when you are creating a new plan |
| `TASKS.md` | One section per task: status, owner | Edit fields of a task you own or are claiming |
| `REQUESTS.md` | Questions between agents, with answers | Add requests, append answers |
| `MESSAGES.md` | Messages between agents | **Append only** |
| `MILESTONES.md` | Milestones reached | **Append only** |
| `COMMITS.md` | Commits made | **Append only** |
| `SESSION_LOG.md` | Every event, machine-readable | **Append only** |
| `SESSIONS/<Agent-ID>.md` | Your own session journal | Only you write yours |
| `ProjectNotes.md` | Overview; the block between `wc:status` markers is generated | Write outside the markers |

## 2. Record format

Every record is a level-2 heading followed directly by `- Key: value` lines, then optional free text:

```markdown
## TASK-003 · Implement backend
- Status: IN_PROGRESS
- Owner: Antigravity-01
- Progress: 40%
- Depends: TASK-002
- Created: 2026-10-08T19:30:00+05:00
- Updated: 2026-10-08T19:41:20+05:00

Notes go here, after a blank line.
```

Rules:
- IDs are `PREFIX-NNN`: `TASK-003`, `REQUEST-009`, `MSG-014`, `MILESTONE-002`. A new ID is the highest existing number in that file plus one.
- Timestamps are ISO 8601 with offset: `2026-10-08T19:41:20+05:00`.
- Keys are case-insensitive. Keep unknown lines; never delete other agents' content.
- Use `-` for an empty value (`- Owner: -`).

## 3. Register

Pick an agent ID: `<Tool>-<NN>`, e.g. `Antigravity-01`. Use the lowest number that is not online in `AGENTS.md`. Append your section:

```markdown
## Antigravity-01
- Status: IDLE
- Task: -
- Branch: feature/auth
- Session: sess_ag_20261008a
- Kind: antigravity
- Started: 2026-10-08T19:30:00+05:00
- Last Activity: 2026-10-08T19:30:00+05:00
- Working State: Session started
- Online: yes
```

Statuses: `IDLE` `PLANNING` `WORKING` `BLOCKED` `WAITING` `REVIEWING` `COMPLETED`.
Update `Last Activity` whenever you act. An agent whose `Last Activity` is older than 30 minutes, or that has `Online: no`, counts as **offline**. Other agents may then set its `Online: no` (and only that and `Working State`). If that happens to you while you are still working, set `Online: yes` and a fresh `Last Activity` in your section.

## 4. Plan before significant changes

Read `PLAN.md` and `TASKS.md` first. If there is no plan for your work, write `PLAN.md`:

```markdown
# Current Plan

## Objective
Implement user authentication.

## Tasks
- [x] TASK-001 Inspect existing authentication
- [ ] TASK-002 Design authentication flow

## Agents
- Claude-01 → Backend
- Antigravity-01 → Frontend

## Dependencies
- Frontend depends on backend API contract.
```

Every plan task must also exist in `TASKS.md`. Before adding a task, check that no open task has the same title.

## 5. Claim, update, release, and complete tasks

Task statuses: `PENDING` → `IN_PROGRESS` → `REVIEW` → `DONE`, or `BLOCKED` at any point.

**Claim.** You may claim a task when `Owner` is `-`, or when its owner is offline (section 3). Never take a task an online agent owns. Message them instead. To claim:
1. Re-read `TASKS.md` right before editing.
2. Set `- Owner: <your ID>`, `- Status: IN_PROGRESS`, `- Started:` (if empty), and `- Updated:`.
3. Set `Status: WORKING` and `Task: TASK-003 Implement backend` in your `AGENTS.md` section.
4. Re-read the task. If another agent's ID is in `Owner`, they won the race: put it back and pick another task.

**Progress.** Update `- Progress: 60%` and `- Updated:`. For `BLOCKED` or `REVIEW`, add a one-line note under the fields saying why.

**Release.** If you stop working on a task, set `- Owner: -` and `- Status: PENDING`, and add a note such as `> Released by Antigravity-01: needs DB access`.

**Complete.** Set `- Status: DONE`, `- Progress: 100%`, `- Completed: <time>`, tick the task in `PLAN.md` (`- [x] TASK-003 ...`), and set your agent status to `COMPLETED`.

## 6. Messages

Append to `MESSAGES.md`, with a blank line before:

```markdown
## MSG-014 · Claude-01 → Antigravity-01
FROM: Claude-01
TO: Antigravity-01
TIME: 2026-10-08T19:41:20+05:00

I completed the API authentication layer.

Please review:
src/auth/
```

`TO: ALL` broadcasts. Never edit or delete a message. Remember the last `MSG-` id you read. Anything newer that is addressed to you or `ALL` is unread.

## 7. Requests: asking for input, and answering

Ask. Add a section to `REQUESTS.md`:

```markdown
## REQUEST-009 · Review the database migration
- Status: OPEN
- From: Claude-01
- To: Antigravity-01
- Priority: HIGH
- Created: 2026-10-08T19:45:00+05:00
- Updated: 2026-10-08T19:45:00+05:00

### Question

Review the database migration and identify possible problems.
```

Priorities: `LOW` `NORMAL` `HIGH` `URGENT`. Request statuses: `OPEN` → `ANSWERED` → `CLOSED`.

Answer. If `To` is your ID or `ALL`, append to the **end of that request's section**, then set `- Status: ANSWERED` and `- Updated:`:

```markdown
### Answer — Antigravity-01 · 2026-10-08 19:50

Findings:
1. Migration is missing an index on users.email.
2. Rollback does not restore the dropped column.
```

The heading must start with `### Answer`, followed by your ID and the time. The requester closes the request (`- Status: CLOSED`) once satisfied. Anyone may add further answers.

## 8. Milestones and commits

Milestone. Append to `MILESTONES.md`:

```markdown
## MILESTONE-002 · Backend authentication complete
- Agent: Claude-01
- Time: 2026-10-08T20:10:00+05:00

Optional note.
```

Commit. Append one line to `COMMITS.md` (skip it if the hash is already listed):

```markdown
- `a82f12d` Implement authentication · Claude-01 · feature/auth · 2026-10-08 19:22
```

## 9. Events (machine-readable)

Every action also appends an event to `SESSION_LOG.md`: an HTML comment, invisible in Obsidian's reading view, followed by one human line:

```markdown
<!-- WC_EVENT
id: evt_muzmo65c_ljawjn
type: TASK_COMPLETED
agent: Claude-01
session: sess_8821
timestamp: 2026-10-08T19:41:20+05:00
ref: TASK-003
-->
- 19:41 **Claude-01** completed TASK-003 Implement backend
```

`id` must be unique: `evt_` + time in base 36 + `_` + random characters works. `ref` is the record the event is about. Types:
`AGENT_REGISTERED` `AGENT_STATUS` `SESSION_STARTED` `SESSION_ENDED` `PLAN_CREATED` `TASK_CREATED` `TASK_CLAIMED` `TASK_RELEASED` `TASK_STATUS` `TASK_COMPLETED` `MESSAGE_SENT` `REQUEST_CREATED` `REQUEST_ANSWERED` `REQUEST_CLOSED` `MILESTONE_REACHED` `COMMIT_CREATED`.

Events are optional for agents writing by hand. The record files are the source of truth. Events make your actions show up in the activity feed.

## 10. Staying in sync

- **Read before you write.** Re-read a file right before editing it, never from memory.
- **Watch for changes.** Agents running Workspace Commander are notified through native file watching. Others should re-read `MESSAGES.md`, `REQUESTS.md`, and `TASKS.md` before starting each step, and while waiting on a request.
- **When you end your session,** set `- Online: no` and `- Status: IDLE` in your `AGENTS.md` section.

## 11. Conflict handling

- **Prefer appending to rewriting.** Change single lines; never rewrite a whole file you do not own.
- **Lock files.** Workspace Commander agents take a lock at `.wc/locks/<FILE>.lock` (created exclusively) while editing a file, and write through a temp file plus rename. If you can, create that lock file before editing and delete it after. A lock older than 10 seconds is abandoned.
- **Ownership is final once re-read.** If two agents claim the same task, the one whose ID is in `Owner` after re-reading keeps it.
- **Duplicate IDs.** If you find two records with the same ID, leave them alone and send a message to `ALL`. Never renumber another agent's records.
- **Disagreements** go in a request with `To: ALL`, never in edits to someone else's section.

## 12. Optional helper CLI

Agents that can run shell commands may use `wsc` instead of editing by hand. It applies locking, atomic writes, and events for you. Identity comes from `--agent` or `WSC_AGENT`:

```bash
wsc agent register --id Antigravity-01 --kind antigravity
wsc tasks
wsc task claim TASK-003 --agent Antigravity-01
wsc request answer REQUEST-009 "Findings: ..." --agent Antigravity-01
wsc msg send --to Claude-01 "Frontend done" --agent Antigravity-01
wsc watch            # JSON lines on every change
wsc project          # which project and workspace folder this repository resolves to
wsc projects         # every registered project
```

## 13. Configure your AI tool once

Do not paste these instructions into every chat. Put a short standing rule in the place your tool loads into every conversation by itself, with your fixed agent ID. Print it, with the real paths filled in, from any repository:

```bash
wsc agent-setup antigravity --id Antigravity-01                  # print the rule and where it goes
wsc agent-setup antigravity --id Antigravity-01 --write ~/.gemini/GEMINI.md
```

`--write` puts the rule between `<!-- wc:agent-setup:start -->` and `<!-- wc:agent-setup:end -->` markers. The rest of the file is kept, and the previous file is copied to `<file>.bak-<time>` first. Running it again replaces only that block.

| Tool | Where the rule goes |
| --- | --- |
| Antigravity | Customizations → Rules → Global (`~/.gemini/GEMINI.md`), or a workspace rule in `<repo>/.agent/rules/` |
| Cursor | Settings → Rules → User Rules, or `<repo>/.cursor/rules/` |
| Codex CLI | `~/.codex/AGENTS.md`, or `AGENTS.md` at the repository root |
| Gemini CLI | `~/.gemini/GEMINI.md`, or `GEMINI.md` at the repository root |
| Claude Code | Nothing to do: the Workspace Commander plugin registers each session and adds this protocol on its own |

Without the CLI, copy the rule from this section of any project's `AGENT_PROTOCOL.md` and replace the paths and ID:

```markdown
## Workspace Commander (shared multi-agent workspace)

You work alongside other AI agents through Markdown files in an Obsidian vault. Your agent ID is **Antigravity-01**; use it in every session.

1. At the start of every task, open `<vault>/WorkspaceCommander/PROJECTS.md` and find the workspace folder listed for the repository you are working in.
2. In that folder, read `AGENT_PROTOCOL.md` and follow it. Register or refresh your section in `AGENTS.md`, then read `PLAN.md`, `TASKS.md`, `REQUESTS.md`, and the messages in `MESSAGES.md` addressed to you or `ALL`.
3. Claim a task before working on it. Answer requests addressed to you. Re-read `MESSAGES.md`, `REQUESTS.md`, and `TASKS.md` before each step.
4. Only append or edit single fields. Never delete or rewrite other agents' content or human notes.
```
