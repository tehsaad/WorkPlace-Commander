#!/usr/bin/env bash
# Live interoperability test with the real AI tools installed on this machine.
#
#   test/acceptance/live-agents.sh [claude] [codex] [antigravity] [gemini]
#
# Opt-in and not part of `npm test`: every tool runs a real model turn, which
# spends your usage. Each tool gets the same job in a throwaway vault and
# repository: read the workspace, claim its task, message Lead-01, complete the
# task, using only the Workspace Commander tools. The Markdown is checked
# afterwards (verify-live.mjs). Nothing in your real vault is touched.
#
# Antigravity has no per-run MCP configuration, so a server named
# wsc-live-test is added with `agy mcp add` and removed again on exit.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/dist/cli.js"
NODE="$(command -v node)"
[ -f "$CLI" ] || { echo "Build first: npm run build" >&2; exit 1; }

TOOLS=("$@")
[ ${#TOOLS[@]} -eq 0 ] && TOOLS=(claude codex antigravity gemini)

T="$(mktemp -d "${TMPDIR:-/tmp}/wsc-live-XXXXXX")"
export XDG_CONFIG_HOME="$T/config" WSC_VAULT="$T/vault"
unset WSC_AGENT WSC_SESSION WSC_WORKSPACE_DIR WSC_CONFIG
PROJECT="$T/live-project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q -b main
git -C "$PROJECT" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
WS="$WSC_VAULT/WorkspaceCommander/live-project"
wsc() { (cd "$PROJECT" && "$NODE" "$CLI" "$@"); }
json() { "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }

AGY_SERVER=""
cleanup() {
  [ -n "$AGY_SERVER" ] && agy mcp remove "$AGY_SERVER" >/dev/null 2>&1
  echo "Workspace kept for inspection: $WS"
}
trap cleanup EXIT

wsc agent register --id Lead-01 --kind human --session lead >/dev/null
echo "Throwaway workspace: $WS"

prompt() {
  local id="$1" title="$2"
  cat <<EOF
You are connected to the workspace-commander MCP tools (a shared multi-agent workspace). Use only those tools: no shell commands, no file edits.
1. Call workspace_status.
2. Claim the task titled "$title" with task_claim.
3. Call message_send with to "Lead-01" and body "ack from <your agent id>: <the text of the newest message addressed to you>".
4. Call task_complete for that task with note "live test".
Then answer with the single word FINISHED.
EOF
}

declare -A RESULT
run_tool() {
  local tool="$1" prefix="$2" id="$3"
  local title="Live check by $prefix"
  local task
  task="$(wsc task add "$title" --agent Lead-01 --json | json .task.id)"
  wsc msg send --to "$id" "Hello $id, the shared workspace works." --agent Lead-01 >/dev/null
  local log="$T/$tool.log"
  echo "--- $tool ($id, $task): running"
  local started=$SECONDS status=0
  case "$tool" in
    claude)
      # The prompt goes first: --allowedTools takes a variadic list.
      (cd "$PROJECT" && timeout 600 claude -p "$(prompt "$id" "$title")" --plugin-dir "$ROOT" \
        --allowedTools "mcp__workspace-commander" </dev/null) >"$log" 2>&1 || status=$?
      ;;
    codex)
      local codex
      codex="$(command -v codex || echo /usr/lib/chatgpt/resources/codex)"
      (cd "$PROJECT" && timeout 600 "$codex" exec --ephemeral --skip-git-repo-check --sandbox read-only -C "$PROJECT" \
        -c "mcp_servers.workspace_commander.command=\"$NODE\"" \
        -c "mcp_servers.workspace_commander.args=[\"$CLI\",\"mcp\",\"--agent\",\"$id\",\"--adapter\",\"codex\",\"--cwd\",\"$PROJECT\"]" \
        -c "mcp_servers.workspace_commander.env={WSC_VAULT=\"$WSC_VAULT\",XDG_CONFIG_HOME=\"$XDG_CONFIG_HOME\"}" \
        -c 'mcp_servers.workspace_commander.default_tools_approval_mode="approve"' \
        "$(prompt "$id" "$title")" </dev/null) >"$log" 2>&1 || status=$?
      ;;
    antigravity)
      AGY_SERVER="wsc-live-test"
      agy mcp add --env "WSC_VAULT=$WSC_VAULT" --env "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" "$AGY_SERVER" -- \
        "$NODE" "$CLI" mcp --agent "$id" --adapter antigravity --cwd "$PROJECT" >>"$log" 2>&1
      (cd "$PROJECT" && timeout 600 agy -p "$(prompt "$id" "$title")" --print-timeout 540s ${AGY_FLAGS:-} </dev/null) >>"$log" 2>&1 || status=$?
      agy mcp remove "$AGY_SERVER" >/dev/null 2>&1 && AGY_SERVER=""
      ;;
    gemini)
      if ! command -v gemini >/dev/null; then
        echo "    SKIPPED: gemini is not installed (npm install -g @google/gemini-cli, then sign in)"
        RESULT[$tool]="SKIPPED (not installed)"
        return
      fi
      mkdir -p "$PROJECT/.gemini"
      printf '{"mcpServers":{"workspace-commander":{"command":"%s","args":["%s","mcp","--agent","%s","--adapter","gemini","--cwd","%s"],"env":{"WSC_VAULT":"%s","XDG_CONFIG_HOME":"%s"}}}}\n' \
        "$NODE" "$CLI" "$id" "$PROJECT" "$WSC_VAULT" "$XDG_CONFIG_HOME" >"$PROJECT/.gemini/settings.json"
      (cd "$PROJECT" && timeout 600 gemini -p "$(prompt "$id" "$title")" --yolo </dev/null) >"$log" 2>&1 || status=$?
      ;;
  esac
  if grep -q "Authentication required" "$log" 2>/dev/null; then
    echo "    SKIPPED: $tool is not signed in. Sign in once in a terminal (run it interactively), then rerun."
    RESULT[$tool]="SKIPPED (not signed in)"
    return
  fi
  local verdict
  verdict="$("$NODE" "$HERE/verify-live.mjs" "$WS" "$prefix" "$task")"
  local ok=$?
  echo "    exit $status after $((SECONDS - started)) s · $verdict"
  if [ $ok -eq 0 ]; then RESULT[$tool]="PASS"; else RESULT[$tool]="FAIL (see $log)"; fi
}

for tool in "${TOOLS[@]}"; do
  case "$tool" in
    claude) run_tool claude Claude "Claude-01" ;;
    codex) run_tool codex Codex "Codex-01" ;;
    antigravity) run_tool antigravity Antigravity "Antigravity-01" ;;
    gemini) run_tool gemini Gemini "Gemini-01" ;;
    *) echo "Unknown tool $tool" >&2 ;;
  esac
done

echo
echo "Live results:"
failed=0
for tool in "${TOOLS[@]}"; do
  echo "  $tool: ${RESULT[$tool]:-not run}"
  [[ "${RESULT[$tool]:-}" == FAIL* ]] && failed=1
done
echo
"$NODE" "$CLI" tasks --cwd "$PROJECT"
exit $failed
