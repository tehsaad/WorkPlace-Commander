# AI tool integrations

Workspace Commander is not tied to Claude Code. Every agent, whatever tool runs it, coordinates through the same Markdown files in the shared workspace, under the same locks. A tool joins through one of three routes, and each tool's route is one entry in [`src/agents/adapters.ts`](../src/agents/adapters.ts).

| Route | How the tool takes part | Registers / heartbeats / ends by itself | Woken on new messages |
| --- | --- | --- | --- |
| `native` | A plugin inside the tool: the Claude Code mod in this repository | yes (hooks) | yes |
| `mcp` | The tool starts `wsc mcp`, a local stdio MCP server, and calls the coordination tools | yes (the server is the session) | no: unread items come with every tool result, and `request_wait` blocks for answers |
| `files` | The tool reads and edits the Markdown by following [`AGENT_PROTOCOL.md`](../AGENT_PROTOCOL.md), optionally running `wsc` from a shell | no: the agent edits its `AGENTS.md` section itself | no |

`wsc adapters` shows every adapter with what is installed on this machine, where its configuration was found, whether its standing rule is in place, and what has been verified.

## Status per tool

Verified means a real session of that tool, driven by `test/acceptance/live-agents.sh`, registered, read the workspace, claimed a task, messaged another agent and completed the task, and the resulting Markdown was checked.

| Tool | Route | Status | Verified with |
| --- | --- | --- | --- |
| Claude Code | native | **Verified live** | Claude Code 2.1.300, 2026-10-15; plus 9 mod tests in Claude Code's own host (`claude plugin test .`) |
| OpenAI Codex CLI | mcp | **Verified live** | codex-cli 0.158.0-alpha.2 (`codex exec`), 2026-10-15 |
| Google Antigravity | mcp | **Not verified live.** The `agy` CLI is installed but not signed in, so the run stopped at Google sign-in. The MCP server it would use is the same one Codex used; running `wsc` inside the `agy` sandbox (with the setup below) was checked. | Protocol tests only |
| Gemini CLI | mcp | **Not verified live.** Gemini CLI 0.64.0 is installed but not signed in. `gemini mcp add` with the arguments below was checked in a scratch HOME. | Protocol tests only |
| Cursor | mcp | **Not verified live.** Not installed. | Protocol tests only |
| Any other agent | files (or mcp) | The Markdown route is exercised by tests that edit the files by hand | `test/integration.test.mjs` |

"Protocol tests" are `test/multiagent.test.mjs`: separate OS processes that speak MCP to real `wsc mcp` servers exactly as a tool does. They prove the server and the shared state; they cannot prove a particular tool's MCP client or permission system.

## Set up a tool

Each tool needs two things, once: a **standing rule** (so every chat knows its agent ID and to use the workspace) and the **MCP server entry** (so it has the tools). `wsc agent-setup <tool>` prints both, filled in with absolute paths.

```bash
wsc adapters                                   # what is installed and supported
wsc agent-setup gemini                         # rule + MCP entry, id Gemini-01
wsc agent-setup antigravity --id Antigravity-01 --write ~/.gemini/GEMINI.md
wsc agent-setup codex --write ~/.codex/AGENTS.md
```

`--write` puts the rule inside a `wc:agent-setup` block, one section per tool, so Gemini CLI and Antigravity (which both read `~/.gemini/GEMINI.md`) each keep their own ID. Everything outside the block is kept, and the file is backed up to `<file>.bak-<time>` first.

### Gemini CLI

1. `wsc agent-setup gemini --write ~/.gemini/GEMINI.md` (or `GEMINI.md` in the repository).
2. Run the printed `gemini mcp add --scope user workspace-commander <node> -- <cli.js> mcp --agent Gemini-01 --adapter gemini` (the `--` matters), or add the printed `mcpServers` entry to `~/.gemini/settings.json`.
3. Sign in once: run `gemini` interactively. Then start it in the repository and ask it to call `workspace_status`.

Gemini CLI asks before running MCP tools unless the server is trusted (`--trust` when adding it, or `"trust": true` in its entry).

### Google Antigravity

1. `wsc agent-setup antigravity --write ~/.gemini/GEMINI.md`, or paste the rule into Agent panel → … → Customizations → Rules → "+ Global".
2. CLI (`agy`): run the printed `agy mcp add workspace-commander -- …` command. IDE: Agent panel → … → MCP Servers → Manage → View raw config, and add the same command and arguments.
3. Sign in once interactively (`agy`) before using `agy -p` headless.

The CLI and the IDE keep separate MCP settings. The IDE (`antigravity` snap, classic confinement) keeps them in `~/.gemini/config/mcp_config.json` and runs your `node` normally.

**The `agy` CLI from the `antigravity-cli` snap is strictly confined.** Its home is `~/snap/antigravity-cli/common`, it has no `node`, and it cannot read hidden folders such as `~/.config` or `~/.claude`. Checked on 1.2.11:

1. Put a Node.js build where the sandbox can run it, e.g. the official `node-v22.x-linux-x64.tar.xz` unpacked to `~/snap/antigravity-cli/common/node`.
2. Start the server from a non-hidden path (the repository under `~/Desktop` works).
3. The sandbox cannot read `~/.config/workspace-commander/projects.json`, so pin the workspace and the real home:
   ```bash
   agy mcp add --env HOME=$HOME --env WSC_WORKSPACE_DIR=<vault>/WorkspaceCommander/<project> workspace-commander -- \
     ~/snap/antigravity-cli/common/node/bin/node <repo>/dist/cli.js mcp --agent Antigravity-01 --adapter antigravity
   ```
   `agy` CLI sessions then coordinate in that one workspace, whichever repository they are opened in.
4. Expected but not verified (it needs a signed-in `agy`): its global rule file is inside its own home, `~/snap/antigravity-cli/common/.gemini/GEMINI.md`, not `~/.gemini/GEMINI.md`.

### OpenAI Codex CLI

1. `wsc agent-setup codex --write ~/.codex/AGENTS.md`.
2. Run the printed `codex mcp add workspace-commander -- …`, or paste the TOML block into `~/.codex/config.toml`.
3. Codex asks before each MCP tool call. `codex exec` cannot ask and refuses them: add `default_tools_approval_mode = "approve"` to the server's table if you run it headless.

Codex does not pass your shell environment to MCP servers: if you rely on `WSC_VAULT` or `XDG_CONFIG_HOME`, set them in the server's `env` table.

### Cursor

`wsc agent-setup cursor` prints a project rule for `.cursor/rules/workspace-commander.mdc` and an `mcpServers` entry for `~/.cursor/mcp.json`.

### Anything else

`wsc agent-setup generic --id MyTool-01` prints a rule for the tool's instruction file. If the tool can start an MCP server, give it the same `wsc mcp` command; if it can run shell commands, `wsc <command> --agent MyTool-01` works; otherwise it follows `AGENT_PROTOCOL.md` by editing the files.

## The MCP server (`wsc mcp`)

```
wsc mcp --agent Gemini-01 --adapter gemini [--cwd <repo>] [--config <file>] [--session <id>]
```

- **Transport:** stdio, newline-delimited JSON-RPC 2.0. Protocol versions 2024-11-05 through 2025-11-25. Only JSON-RPC is written to stdout; diagnostics go to stderr. No dependencies.
- **Tools:** `workspace_status`, `plan_create`, `task_add`, `task_claim`, `task_update`, `task_complete`, `task_release`, `message_send`, `request_create`, `request_answer`, `request_close`, `request_wait`, `milestone`, `agent_status`, `context_note`. They are the Claude Code mod's tools (one definition in [`src/coordination/tools.ts`](../src/coordination/tools.ts)), and each runs the `wsc` CLI's code path as this agent. Tools carry MCP annotations (`readOnlyHint` on `workspace_status` and `request_wait`; nothing is destructive or open-world).
- **Session:** on `initialize` the server registers the agent with the adapter's kind and capabilities and `Process: <pid>@<host>`, and marks agents that went stale offline. It heartbeats every 2 minutes while the tool runs, and ends the session when the tool closes its stdin.
- **Identity:** `--agent` is the preferred ID. If another session of that ID is online and its recorded process is still running on this machine, the server uses the next free ID with the same prefix (`Gemini-02`) and says so on stderr. If the previous process is dead (crash, kill), the server takes the ID over and the agent's tasks are listed under "Your open tasks" in `workspace_status`.
- **Which project:** `--cwd`, else the first `file://` root the client reports (MCP `roots/list`), else the server's working directory. If `workspace_status` shows the wrong project, add `--cwd <repo>`.
- **What the agent learns, and when:** `workspace_status` returns the agent's open tasks, available tasks, tasks whose owner went offline (claimable), agents online, unread messages, requests waiting for it, and answers to its own requests, then marks the messages delivered. Every other tool result also carries messages that arrived since. `request_wait` blocks until a request is answered or its timeout passes (keep it under the tool's call timeout).

## Security model

- Everything stays on this machine: the MCP server speaks only over the stdio of the tool that started it, the dashboard binds to 127.0.0.1 with a per-run token, and nothing calls a network service.
- Agent IDs and recipients must be one token (`^[A-Za-z][\w.-]{0,40}$`). Free text written into records is escaped so it cannot start a `##` record or a `### Answer` heading, hide text in an HTML comment, or leave a code fence open. A message cannot impersonate another agent's message or answer.
- Configured file names are plain names inside the workspace folder. A repository's own `.workspace-commander.json` cannot move the vault or point the workspace outside it, so opening a cloned repository cannot make an agent write elsewhere.
- Not a security boundary: any process running as you can edit the vault, and agent IDs are not authenticated. The protocol prevents accidents between cooperating agents, not a hostile local process.

## Add a tool

Add an entry to `ADAPTERS` in `src/agents/adapters.ts`: key, name, `kind`, ID prefix, route, capabilities, executables and config folders (for detection), where its rules go, and how its MCP entry is configured (a `{launch}` command template, or a JSON/TOML snippet). Leave `verified` empty until a live run passes, then add the tool to `test/acceptance/live-agents.sh`.
