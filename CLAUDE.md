# Workspace Commander · notes for Claude Code sessions

Multi-agent coordination over plain Markdown in an Obsidian vault. Three parts share one library:

- **Mod** (`hooks/register.tsx`, `src/mod/*`): runs inside Claude Code's hooks sandbox (no Node, no DOM). Registers each session as `Claude-NN`, briefs it on its first prompt, watches the workspace, provides `/wc`, `/togglegit` and the `workspace_status`, `task_*`, `message_send`, `request_*`, `milestone`, `agent_status`, `plan_create` tools.
- **`wsc` CLI** (`src/cli.ts`, `src/commands/run.ts`): the Node side the mod calls, also usable by hand and by other AIs.
- **Web dashboard** (`dashboard/server.mjs` + `dashboard/public/`): Node with no dependencies, loopback only, per-run token, Server-Sent Events.

`AGENT_PROTOCOL.md` is the file format and the contract for every agent. Do not change a record format without updating it and the tests.

## Layout

| Path | What |
| --- | --- |
| `src/obsidian/` | Markdown records, workspace files, snapshots |
| `src/coordination/` | tasks, messages, requests |
| `src/agents/agents.ts` | agent registry, heartbeat target, stale-agent reaper |
| `src/config/` | user config and the project registry (`projects.ts`) |
| `src/filesystem/` | atomic writes, locks, native file watching |
| `src/git/`, `src/events/`, `src/dashboard/` | Git panel, event formatting, the shared view model |
| `src/mod/` | mod-only code (bridge to `wsc`, inbox, state, tools, pane) |
| `test/integration.test.mjs` | CLI tests against real processes, files and git |
| `test/mod/mod.test.tsx` | mod tests run in Claude Code's host |
| `dashboard/test/` | dashboard server tests |
| `docs/creation/` | how the project was built (history; do not edit the archived workspace) |
| `docs/ROADMAP.md` | open work and proposals awaiting approval |

## Commands

```bash
npm install && npm run build   # compile src/ to dist/ (the CLI and dashboard use dist/)
npm test                       # build + CLI integration + dashboard server tests
npm run test:mod               # claude plugin validate . && claude plugin test .
npm run typecheck              # CLI + mod; one known TS2589 at test/mod/mod.test.tsx:230
npm run dev                    # rebuild dist/ on save
npm run dashboard              # http://127.0.0.1:4777
claude --plugin-dir .          # run the mod from source, hot reload
```

Run `npm test` and `npm run test:mod` before every commit that touches code.

## Dev vs installed

- **Source run:** `claude --plugin-dir <repo>` loads the mod from this folder. Edits to `hooks/` and `src/mod/` reload live; other `src/` edits need `npm run dev` (or `npm run build`). Only `.claude-plugin/plugin.json` changes need a new session.
- **Installed:** Claude Code runs a **copy** under `~/.claude/plugins/cache/workspace-commander/workspace-commander/<version>/`. Editing the source does nothing to it until you release.
- **Release:** bump `version` in **both** `package.json` and `.claude-plugin/plugin.json`, build and test, then
  ```bash
  claude plugin marketplace update workspace-commander
  claude plugin update workspace-commander@workspace-commander
  ```
  and restart the sessions. `wsc` in `~/.local/bin` links to this repo's `dist/cli.js`, so it follows the source after a build.

## Rules

- **Coordinate first.** When the workspace tools are available, call `workspace_status`, claim a task before working on it, and message the files you will edit. Never edit a file another online agent owns or changed in the last few minutes; ask with `request_create` and wait.
- **Never overwrite notes.** Edit single fields. Generated blocks sit between `wc:` markers. Back up before regenerating.
- **Keep other agents' work.** The `beat()` heartbeat in `hooks/register.tsx` and the reaper in `src/agents/agents.ts` must stay intact.
- **Test like a user.** After changing startup or briefing behavior, also run a fresh `claude -p` session against a throwaway vault: `XDG_CONFIG_HOME=<tmp>/config WSC_VAULT=<tmp>/vault`.
- **Keep test data out of the real vault.** Browser and dashboard tests use a throwaway vault.
- **Git:** small commits on a branch, messages ending with the `Co-Authored-By` line, PR into `main`. Never force-push.

## Known limits

- A full GUI inside Claude Code is impossible: mods draw only `Box`, `Text` and `Button`. The browser dashboard is the full interface; the pane stays compact.
- The dashboard's Git Hide/Show switch is a browser preference and cannot reach `/togglegit`'s state in Claude Code's private plugin store.
- An agent shows as online only while its session keeps `Last Activity` fresh (heartbeat every 2 minutes, offline after 30).
- The GitHub MCP connector in Claude Code currently fails to authenticate; use `gh` or `git`.
