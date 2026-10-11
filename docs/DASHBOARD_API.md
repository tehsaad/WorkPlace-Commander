# Dashboard API contract

The browser dashboard (`dashboard/public/`) talks to `dashboard/server.mjs` only through the HTTP API below. This file is the contract between the backend (owned by Agent A: `src/`, `hooks/`, `dashboard/server.mjs`) and the frontend (owned by Agent B: `dashboard/public/`).

- The frontend never imports `src/` and never touches vault files directly. Every write goes through `POST /api/action`.
- The backend may **add** fields at any time. It does not rename, remove, or change the type of a documented field without a coordinated task and a version note at the bottom of this file.
- `dashboard/test/contract.test.mjs` checks this document against the running server. If you change the API, update both, or the test fails.

Version: **1** (Workspace Commander 0.3.0).

## Transport and security

| Rule | Detail |
| --- | --- |
| Base URL | `http://127.0.0.1:<port>` (default port 4777) |
| Host header | Must be one of the bound loopback names (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`), otherwise **421** |
| Token | Every `/api/*` call sends the per-run token as the header `x-wc-token`, or as `?token=` (needed for `EventSource`). The token is in `<meta name="wc-token">` of the served `index.html`. Missing or wrong → **403** |
| Origin | `POST` with an `Origin` header that is not a bound loopback name → **403** |
| Body | JSON, at most 256 000 bytes (→ **413**). Invalid JSON → **400** |
| Caching | All API responses are `cache-control: no-store` |
| Frontend assets | Served from `dashboard/public/` only, under a strict Content-Security-Policy: `script-src 'self'`, `style-src 'self'` (inline `style=""` attributes allowed), `connect-src 'self'`, `img-src 'self' data:`. No CDN scripts, no inline `<script>`, no external fonts |

A server restart issues a new token. The frontend should treat a **403** with an otherwise working server as "reload the page".

## Error envelope

Every failure, on every endpoint, is JSON:

```json
{ "ok": false, "error": "TASK-004 is owned by Claude-01; claim it first", "code": "refused" }
```

| Status | `code` | Meaning | What the UI should do |
| --- | --- | --- | --- |
| 400 | `invalid` | Missing or malformed input, unknown action, invalid JSON | Show `error` next to the form; nothing was written |
| 403 | `invalid` | Wrong token or cross-origin write | Ask the user to reload |
| 404 | `invalid` | Unknown path or unknown `project` slug | Show `error`; for a project, fall back to the project list |
| 409 | `refused` | The coordination rules refused the action (see [Refusals](#refusals)) | Show `error`; where the action takes `force`, offer an explicit override |
| 413 | `invalid` | Body too large | Show `error` |
| 421 | `invalid` | Unexpected Host header | Not reachable from the served page |
| 500 | `error` | Unexpected server failure (also logged to the server's terminal) | Show `error` and keep the last good state on screen |

`error` is always a human-readable sentence and safe to show as text (never as HTML).

## `GET /api/projects`

Every registered project, plus the project the server's start directory resolves to.

```json
{
  "projects": [
    { "slug": "my-app", "name": "my-app", "workspace": "/Users/me/Obsidian/WorkspaceCommander/my-app", "roots": ["/Users/me/code/my-app"] }
  ],
  "current": "my-app"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `projects[].slug` | string | Pass it as `?project=` / `"project"` to every other call |
| `projects[].name` | string | Display name |
| `projects[].workspace` | string | Absolute path of the project's vault folder |
| `projects[].roots` | string[] | Repository paths registered to this project (may no longer exist) |
| `current` | string | The default slug when `project` is omitted |

## `GET /api/state?project=<slug>`

Everything the dashboard draws, parsed from the Markdown on each request. `project` is optional (defaults to `current`).

```json
{
  "project":  { "slug": "my-app", "name": "my-app", "workspace": "…", "roots": ["…"] },
  "snapshot": { "project": "my-app", "workspace": "…", "agents": [], "tasks": [], "requests": [], "messages": [], "milestones": [], "commits": [], "events": [], "plan": "" },
  "git":      { "available": true, "branch": "main", "commits": [] },
  "config":   { "vault": "…", "workspace": "…", "staleAgentMinutes": 30, "protocol": "…/AGENT_PROTOCOL.md", "configSources": ["…"], "registry": "…/projects.json" },
  "identity": "Human-01",
  "now": 1791705490000,
  "serverStarted": 1791705000000
}
```

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `project` | object | Same shape as an entry of `/api/projects` |
| `snapshot` | object | The parsed workspace, below |
| `git` | object | `available: false` when the project has no reachable git repository; then `branch` is `""` and `commits` is `[]` |
| `config.vault` | string | Absolute vault path |
| `config.workspace` | string | Absolute workspace folder |
| `config.staleAgentMinutes` | number | An agent whose `lastActivity` is older than this counts as offline |
| `config.protocol` | string | Absolute path of the project's `AGENT_PROTOCOL.md` |
| `config.configSources` | string[] | Config files that were loaded, in order |
| `config.registry` | string | Absolute path of `projects.json` |
| `identity` | string | The server's default agent ID for writes (`--as`). A write may override it with `"as"` |
| `now` | number | Server time, ms since epoch. Use it, not the browser clock, for "x minutes ago" |
| `serverStarted` | number | ms since epoch; changes when the server restarts |

### `snapshot`

All timestamps are ISO 8601 strings with offset (`2026-10-08T19:41:20+05:00`), or `""` when not set. An empty Markdown value (`-`) arrives as `""`.

| Field | Type | Notes |
| --- | --- | --- |
| `project`, `workspace` | string | |
| `agents[]` | Agent | From `AGENTS.md` |
| `tasks[]` | Task | From `TASKS.md`, in file order |
| `requests[]` | Request | From `REQUESTS.md` |
| `messages[]` | Message | From `MESSAGES.md`, **the latest 200 only** |
| `milestones[]` | Milestone | From `MILESTONES.md` |
| `commits[]` | CommitRecord | From `COMMITS.md` (commits recorded by agents) |
| `events[]` | WorkspaceEvent | From `SESSION_LOG.md`, **the latest 200 only** |
| `plan` | string | Raw Markdown of `PLAN.md` (`""` if absent). Render it as Markdown text, never as raw HTML |

**Agent**: `id`, `status` (`IDLE` `PLANNING` `WORKING` `BLOCKED` `WAITING` `REVIEWING` `COMPLETED`), `task`, `branch`, `session`, `kind` (`claude-code`, `antigravity`, `human`, … free text), `started`, `lastActivity`, `workingState`: strings; `online`: boolean.
An agent is **online** when `online` is `true` **and** `now - lastActivity < staleAgentMinutes` (a `lastActivity` that does not parse counts as recent). The file flag alone is not enough.

**Task**: `id` (`TASK-003`), `title`, `status` (`PENDING` `IN_PROGRESS` `REVIEW` `BLOCKED` `DONE`), `owner` (`""` = unowned), `created`, `updated`, `started`, `completed`, `notes`: strings; `depends`: string[] of task IDs; `progress`: number 0–100 **or absent**.

**Request**: `id`, `title`, `status` (`OPEN` `ANSWERED` `CLOSED`), `from`, `to` (agent ID or `ALL`), `priority` (`LOW` `NORMAL` `HIGH` `URGENT`), `created`, `updated`, `question`: strings; `answers[]`: `{ agent, timestamp, body }`.

**Message**: `id` (`MSG-014`), `from`, `to` (agent ID or `ALL`), `timestamp`, `body`: strings.

**Milestone**: `id`, `title`, `agent`, `timestamp`, `note`: strings.

**CommitRecord**: `hash`, `subject`, `agent`, `timestamp`, `branch`: strings.

**WorkspaceEvent**: `id`, `type`, `agent`, `session`, `timestamp`, `summary`: strings; `ref`: string or absent. `type` is one of `AGENT_REGISTERED` `AGENT_STATUS` `SESSION_STARTED` `SESSION_ENDED` `PLAN_CREATED` `TASK_CREATED` `TASK_CLAIMED` `TASK_RELEASED` `TASK_STATUS` `TASK_COMPLETED` `MESSAGE_SENT` `REQUEST_CREATED` `REQUEST_ANSWERED` `REQUEST_CLOSED` `MILESTONE_REACHED` `COMMIT_CREATED`.

Records a person typed by hand can contain unknown keys or odd values. The frontend must tolerate an unknown `status` (show it as text) rather than crash.

### `git`

| Field | Type | Notes |
| --- | --- | --- |
| `available` | boolean | |
| `branch` | string | `""` if unknown (e.g. detached or no commits) |
| `commits[]` | `{ hash, subject, date, author, agent }` | The latest `gitLogCount` (default 5) commits, newest first. `hash` is abbreviated, `date` is ISO 8601, `agent` is the agent that recorded it in `COMMITS.md` or `""` |

## `GET /api/events?project=<slug>&token=<token>`

A Server-Sent Events stream. It carries **notifications only**, never data: on a change, call `GET /api/state` again.

| Event | `data` | Meaning |
| --- | --- | --- |
| `hello` | `{ "project": "<slug>" }` | Sent once when the stream opens |
| `change` | `{ "kind": "workspace", "files": ["TASKS.md"] }` | A file in the workspace folder changed (by anyone: Obsidian, a Claude session, `wsc`, another agent, the dashboard itself). Debounced |
| `change` | `{ "kind": "git", "files": [...] }` | Something under `.git` changed (commit, checkout, ref update) |

A comment line (`: ping`) is sent every 25 s to keep the connection open. If the stream drops, the browser's `EventSource` reconnects by itself; the UI should show that it is reconnecting and refetch `/api/state` once it is back, because changes during the gap are not replayed.

## `POST /api/action`

```json
{ "action": "task.claim", "project": "my-app", "as": "Human-01", "id": "TASK-003", "force": false }
```

| Common field | Type | Notes |
| --- | --- | --- |
| `action` | string | One of the actions below. Anything else → 400 |
| `project` | string | Optional; defaults to `?project=`, then `current` |
| `as` | string | Optional agent ID to act as (`^[A-Za-z][\w.-]{0,40}$`); invalid or absent → the server's `identity`. On its first write, an unknown ID is registered in `AGENTS.md` with `Kind: human` |
| `force` | boolean | Only for the task actions marked *force*: overrides the ownership refusal (409) |

Success is always `{ "ok": true, "data": … }`. The file write has finished when the response arrives; the `change` event follows.

| `action` | Fields | `data` |
| --- | --- | --- |
| `task.add` | `title` (≤300), `depends?`: string[] | `{ task, created }`. `created: false` means an open task with the same title (case and spacing ignored) already existed and is returned instead |
| `task.claim` | `id`, `force?` | `{ task, unmetDependencies: string[], tookOverFrom? }`. Unmet dependencies are a warning, not a refusal |
| `task.status` | `id`, `status` (task status), `progress?` 0–100, `note?`, `force?` | `Task` |
| `task.complete` | `id`, `note?`, `force?` | `Task` |
| `task.release` | `id`, `note?`, `force?` | `Task` |
| `message.send` | `to` (agent ID or `ALL`, ≤60), `body` | `Message` |
| `request.create` | `to` (≤60), `question`, `title?` (≤200), `priority?` | `Request` |
| `request.answer` | `id`, `answer`, `close?`: boolean | `Request` |
| `request.close` | `id` | `Request` |
| `milestone.add` | `title` (≤300), `note?` | `Milestone` |
| `plan.create` | `objective`, `tasks?`: string[], `notes?` | `{ path, tasks: Task[], archived? }`. **Replaces `PLAN.md`**; the previous plan is moved to `PLANS/` (`archived` is its path). Ask for confirmation in the UI when a plan exists |
| `agent.status` | `status` (agent status), `state?` (working state text) | `Agent` |

String fields are limited to 20 000 characters unless a smaller limit is given. Enum fields are case-insensitive.

### Refusals

409 `refused` is returned when the shared coordination rules say no. The current reasons:

- The task, or request, does not exist.
- A task is already `DONE` (claim).
- The task is owned by another **online** agent (claim, status, complete, release). These accept `force: true`.
- An empty title, body, question, answer or objective.

## Things this API deliberately does not do

- **Git Hide/Show.** The dashboard's Git switch is a per-browser preference (kept in `localStorage`). The Claude Code pane's `/togglegit` state lives in Claude Code's plugin store, which the server cannot read. The two are independent by design; the server has no endpoint for either.
- **Read-state / unread markers and the startup briefing.** These live in Claude Code's plugin store today and are not exposed. Planned as task A2 (moving the marker into the vault and exposing it here).
- **Arbitrary file reads.** Only the parsed snapshot and `plan` are served. Read-only previews of `AGENT_PROTOCOL.md`, `ProjectNotes.md` and session journals are planned as task A3.

## Changelog

- **1** (0.3.0): first written contract, describing the API as shipped.
