# Roadmap

State as of 0.4.0 (2026-10-15). The live board is `PLAN.md` / `TASKS.md` in the shared workspace (`wsc tasks`); this file records what is done, what is partly done, and what remains, so work can resume from the repository alone. Every "done" item below is backed by a test in the repository or a recorded live run.

## Completed

| Item | Evidence |
| --- | --- |
| TASK-001 Stale agents marked offline (locked reaper + idle heartbeat) | integration tests; mod test "an idle session heartbeats" |
| TASK-002 Git panel in a real git repository | integration and dashboard tests |
| TASK-005 Per-project workspaces, project registry, stable `Claude-NN` ids | integration tests "projects: persistent registry and isolation" |
| Web dashboard, `wsc agent-setup`, GitHub publication (0.3.0) | dashboard server tests |
| **Adapter architecture** (`src/agents/adapters.ts`): one entry per tool with route (`native` / `mcp` / `files`), kind, id prefix, capabilities, rule file, MCP setup, verification status; `wsc adapters` detects what is installed | multiagent tests, live runs |
| **`wsc mcp`**: stdio MCP server with the mod's tools for any MCP client; registers with kind, capabilities and `Process`, heartbeats, ends the session on exit, finds the repository from `--cwd` or client roots, appends unread messages to results, tool annotations | 12 acceptance tests in `test/multiagent.test.mjs` |
| **Shared context for agents without hooks**: `workspace_status` / `wsc context` (own open tasks first, available and recoverable tasks, unread messages with a read cursor, requests waiting, answers), `request_wait` / `wsc request wait`, `context_note` / `wsc note add` | acceptance tests |
| **Unique, stable ids across processes**: a second live process with the same preferred id gets the next one; a restart after a crash (dead pid) resumes the id and its tasks | acceptance tests "two MCP agents … distinct ids", "killed mid-task restarts" |
| **Crash and stale recovery**: stale agents reaped on the next registration; their tasks listed as recoverable and taken over with the takeover recorded | acceptance test "a stale agent is reaped" |
| **Bug: stale-lock steal race** (two processes could hold one lock) and slow recovery from dead lock holders | regression tests (failed before the fix: lost increments) |
| **Bug: duplicate task ownership** when the first claimant had no `AGENTS.md` record yet | regression test (2 owners before the fix) |
| **Security: record injection** (a body could forge messages or answers; ids and recipients were unchecked) | regression tests, dashboard test |
| **Security: config path escapes** (a cloned repository's config could write outside the vault) | regression tests |
| **Dashboard**: task detail drawer (live), connection and error banners, loading state, recovery after a server restart (new token), skip link, focus trap, labelled cards, live-region announcements, AA contrast for small text, capabilities in the agents view, phone layout | 7 browser tests in headless Chrome (`npm run test:ui`), 13 server tests |
| **Live interoperability**: Claude Code 2.1.300 and codex-cli 0.158.0-alpha.2 each registered, claimed, messaged and completed a task through Workspace Commander | `test/acceptance/live-agents.sh claude codex`, 2026-10-15 |
| Installation, upgrade, troubleshooting and uninstall documentation; `./install.sh --uninstall` | README; uninstall checked in a scratch HOME |
| TASK-003 Dev vs installed workflow documented | README "Development", "Upgrade", "Troubleshooting"; `CLAUDE.md` |

## Partially completed

| Item | Done | Missing |
| --- | --- | --- |
| TASK-004 Cross-session and Antigravity interoperability | Cross-session: done (independent processes, MCP and CLI, restarts). Antigravity: adapter, rule, `agy mcp add` setup, live script | A passing live Antigravity run: the `agy` CLI on the build machine was not signed in (Google sign-in required once, interactively) |
| Gemini CLI integration | Adapter, rule, `settings.json` MCP snippet, live script entry | Gemini CLI is not installed on the build machine: never run live |
| Cursor integration | Adapter, rule, MCP snippet | Not installed: never run live |
| Wake-up for non-Claude agents | Unread items ride along with every tool result; `request_wait` blocks | MCP tools cannot start a turn in an idle tool; an idle Gemini/Codex/Antigravity session learns of new messages only on its next tool call |
| Typecheck | CLI typecheck clean | `npm run typecheck` still reports one TS2589 in `test/mod/mod.test.tsx` from the host's generated types (pre-existing; moving it to another call site just moves the error) |

## Remaining

- Run `npm run test:live -- antigravity` after signing in to `agy`, and `-- gemini` after installing Gemini CLI; set `verified` in their adapters only when it passes.
- Dashboard: split `app.js` (≈1,300 lines) into modules with no behavior change; an API contract (`apiVersion`, `dashboard/API.md`) with contract tests.
- The dashboard's Git Hide/Show switch is still independent of `/togglegit` (a separate process cannot reach the mod's plugin store); document as by design or share a `ui.json`.
- Agent ids are not authenticated: any local process can act as any id. Acceptable for cooperating local agents; would need signed records for anything stronger.
- A long-running holder of a workspace lock (over `lockStaleMs`, 10 s) on another machine (synced vault) can still be judged stale by age alone.
- CLAUDE.md at the repository root makes `claude plugin validate` warn that it is not plugin context; it is meant for people developing in the repository.

## Proposed: backend / GUI split

**Awaiting the user's approval. Do not start without it.**

- **Agent A, backend and mod.** Owns `src/**`, `hooks/**`, `types/**`, `test/**`, `dashboard/server.mjs`, the dashboard server tests, a new `dashboard/API.md`, `AGENT_PROTOCOL.md`, `install.sh`, `package.json`, `.claude-plugin/**`.
- **Agent B, GUI.** Owns `dashboard/public/**`, `dashboard/test/ui/**`, a new `dashboard/DESIGN.md`.

Open questions for the user:

1. What exactly is "Claude Design"?
2. Should B work in its own git worktree?
3. Git toggle: integrate through a shared `ui.json`, or document as unsupported?
4. What name should the dashboard user have?
