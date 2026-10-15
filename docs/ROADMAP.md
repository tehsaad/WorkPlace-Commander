# Roadmap

State as of 0.3.0 (2026-10-15). The live board is `PLAN.md` / `TASKS.md` in the shared workspace (`wsc tasks`); this file records what is open and what is proposed so work can resume from the repository alone.

## Done

| ID | Task |
| --- | --- |
| TASK-001 | Mark stale agents offline in `AGENTS.md` (locked reaper + idle heartbeat) |
| TASK-002 | Verify the Git panel in a real git repository |
| TASK-005 | Persistent multi-session coordination: per-project workspaces, project registry, stable `Claude-NN` IDs across session-ID changes (0.2.x) |
| – | Web dashboard, `wsc agent-setup`, GitHub publication (0.3.0) |

## Open

| ID | Task | Notes |
| --- | --- | --- |
| TASK-003 | Document dev vs installed workflow | Mostly covered by the README sections "Installation" and "Development / hot reload" and by `CLAUDE.md`. Remaining: a short troubleshooting list (stale installed copy, forgotten version bump, session not restarted). |
| TASK-004 | Cross-session and Antigravity interoperability test | Needs a one-time setup by the user: `wsc agent-setup antigravity --id Antigravity-01`. Then exercise claim, message, request/answer between a Claude session and Antigravity. |

## Proposed: backend / GUI split

**Awaiting the user's approval. Do not start without it.**

- **Agent A, backend and mod.** Owns `src/**`, `hooks/**`, `types/**`, `test/**`, `dashboard/server.mjs`, the dashboard server tests, a new `dashboard/API.md`, `AGENT_PROTOCOL.md`, `install.sh`, `package.json`, `.claude-plugin/**`.
  - Freeze the API contract with `apiVersion` and contract tests.
  - `GET /api/briefing`.
  - `GET /api/note` (allowlisted Markdown previews).
  - Decide the Git Hide/Show toggle.
- **Agent B, GUI.** Owns `dashboard/public/**`, a new `dashboard/test/ui/**`, a new `dashboard/DESIGN.md`.
  - Split `app.js` into modules with no behavior change.
  - Design and accessibility pass; loading, empty and error states.
  - Task detail drawer.
  - Briefing panel and Markdown previews (depend on A's endpoints).
  - Browser tests.

Open questions for the user:

1. What exactly is "Claude Design"?
2. Should B work in its own git worktree?
3. Git toggle: integrate through a shared `ui.json`, or document as unsupported?
4. What name should the dashboard user have?
