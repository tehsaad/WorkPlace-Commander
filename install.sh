#!/usr/bin/env bash
# Workspace Commander installer.
#
#   ./install.sh                          interactive
#   ./install.sh --vault ~/Notes --yes    non-interactive, answers yes to every prompt
#
# Options:
#   --vault PATH          Obsidian vault folder        (default: ~/Documents/Obsidian)
#   --workspace-dir NAME  Folder inside the vault      (default: WorkspaceCommander)
#   --notes NAME          Project notes file name      (default: ProjectNotes.md)
#   --yes                 Answer yes to every question (still never overwrites config without --force-config)
#   --force-config        Overwrite an existing config file
#   --no-build            Skip npm install / build
#   --no-claude           Do not register the plugin with Claude Code
#   --no-link             Do not link the `wsc` command into ~/.local/bin
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="~/Documents/Obsidian"
WORKSPACE_DIR="WorkspaceCommander"
NOTES="ProjectNotes.md"
YES=0
FORCE_CONFIG=0
BUILD=1
CLAUDE=1
LINK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --force-config) FORCE_CONFIG=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --no-claude) CLAUDE=0; shift ;;
    --no-link) LINK=0; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
ask() {
  # ask "question" -> 0 for yes
  if [ "$YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  local reply
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}
expand() { case "$1" in "~") echo "$HOME" ;; "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }

bold "1. Environment"
OS="$(uname -s)"
ok "OS: $OS $(uname -m)"
command -v node >/dev/null || fail "Node.js is required (>= 20.11): https://nodejs.org"
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=11)?0:1)' \
  || fail "Node.js $NODE_VERSION is too old; 20.11 or newer is required"
ok "Node.js $NODE_VERSION ($(command -v node))"
command -v npm >/dev/null || fail "npm is required"
ok "npm $(npm -v)"

bold "2. Git"
command -v git >/dev/null || fail "git is required for the Git panel and commit tracking"
ok "$(git --version)"

bold "3. Build"
if [ "$BUILD" = 1 ]; then
  (cd "$HERE" && npm install --no-audit --no-fund --silent && npm run build --silent)
  ok "Built $HERE/dist"
else
  [ -f "$HERE/dist/cli.js" ] || fail "dist/cli.js missing; run without --no-build"
  ok "Skipped (dist present)"
fi
node "$HERE/dist/cli.js" --help >/dev/null || fail "dist/cli.js does not run"
ok "wsc CLI runs"

bold "4. Configuration"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/workspace-commander"
CONFIG="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
WRITE_CONFIG=1
if [ -f "$CONFIG" ]; then
  if [ "$FORCE_CONFIG" = 1 ]; then
    warn "Overwriting $CONFIG (--force-config); previous copy saved as config.json.bak"
    cp "$CONFIG" "$CONFIG.bak"
  elif [ "$YES" = 0 ] && ask "$CONFIG exists. Overwrite it (a .bak copy is kept)?"; then
    cp "$CONFIG" "$CONFIG.bak"
  else
    WRITE_CONFIG=0
    ok "Kept existing $CONFIG"
  fi
fi
if [ "$WRITE_CONFIG" = 1 ]; then
  node -e '
    const [file, obsidianVault, workspaceDir, projectNotes] = process.argv.slice(1)
    require("fs").writeFileSync(file, JSON.stringify({ obsidianVault, workspaceDir, projectNotes }, null, 2) + "\n")
  ' "$CONFIG" "$VAULT" "$WORKSPACE_DIR" "$NOTES"
  ok "Wrote $CONFIG"
fi
# Read back what is actually configured (an existing file may differ from the flags).
RESOLVED_VAULT="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(c.obsidianVault||"~/Documents/Obsidian")' "$CONFIG")"
RESOLVED_DIR="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(c.workspaceDir||"WorkspaceCommander")' "$CONFIG")"
VAULT_PATH="$(expand "$RESOLVED_VAULT")"
WORKSPACE_PATH="$VAULT_PATH/$RESOLVED_DIR"

bold "5. Obsidian vault"
if [ -d "$VAULT_PATH/.obsidian" ]; then
  ok "Obsidian vault detected: $VAULT_PATH"
elif [ -d "$VAULT_PATH" ]; then
  ok "Folder exists: $VAULT_PATH (open it in Obsidian with 'Open folder as vault')"
else
  if ask "Create the vault folder $VAULT_PATH?" || [ "$YES" = 1 ]; then
    mkdir -p "$VAULT_PATH"
    ok "Created $VAULT_PATH (open it in Obsidian with 'Open folder as vault')"
  else
    fail "Vault folder $VAULT_PATH does not exist. Re-run with --vault PATH."
  fi
fi
mkdir -p "$WORKSPACE_PATH"
[ -w "$WORKSPACE_PATH" ] || fail "$WORKSPACE_PATH is not writable"
# Each project gets its own folder in here on its first session (projects.json).
ok "Projects folder: $WORKSPACE_PATH (one subfolder per project, listed in PROJECTS.md)"

bold "6. wsc command"
if [ "$LINK" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  if [ -e "$HOME/.local/bin/wsc" ] && [ "$(readlink "$HOME/.local/bin/wsc")" != "$HERE/dist/cli.js" ]; then
    warn "$HOME/.local/bin/wsc exists and points elsewhere; left alone"
  else
    ln -sf "$HERE/dist/cli.js" "$HOME/.local/bin/wsc"
    ok "Linked $HOME/.local/bin/wsc"
  fi
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "Add ~/.local/bin to PATH to use 'wsc' directly" ;; esac
else
  ok "Skipped"
fi

bold "7. Claude Code"
if [ "$CLAUDE" = 1 ] && command -v claude >/dev/null; then
  ok "$(claude --version)"
  claude plugin validate "$HERE" >/dev/null 2>&1 && ok "Mod validates" || fail "claude plugin validate failed: run it in $HERE for details"
  if ask "Register Workspace Commander with Claude Code (user scope, read from this folder)?"; then
    claude plugin marketplace add "$HERE" >/dev/null 2>&1 || true
    if claude plugin install workspace-commander@workspace-commander >/dev/null 2>&1; then
      ok "Installed workspace-commander@workspace-commander (edits here apply after /reload-plugins)"
    else
      warn "Install did not complete; run: claude plugin install workspace-commander@workspace-commander"
    fi
  else
    ok "Skipped; to load it for one session: claude --plugin-dir $HERE"
  fi
elif [ "$CLAUDE" = 1 ]; then
  warn "claude CLI not found; install Claude Code, then: claude plugin marketplace add $HERE && claude plugin install workspace-commander@workspace-commander"
fi

bold "Done"
cat <<EOF

  Workspace:  $WORKSPACE_PATH
  Config:     $CONFIG

  Start (in your project):    cd <your-project> && claude
  One session from source:    claude --plugin-dir $HERE
  Dashboard:                  /wc        Git panel: /togglegit
  Development (watch build):  cd $HERE && npm run dev
  Projects:                   wsc projects      (registered on each repository's first session)
  External agents, once each: wsc agent-setup antigravity --id Antigravity-01

EOF
