#!/bin/sh
# Popup: pick a project, then a Linear issue by typing its id or a few words
# of its title (fzf). herdr creates the worktree on the issue's branch; the
# worktree.created event makes DevFlow provision it.
set -eu
. "$(dirname "$0")/lib.sh"

# The popup closes with the script; keep a trace of what happened.
LOG="${HERDR_PLUGIN_STATE_DIR:-/tmp}/linear.log"
mkdir -p "$(dirname "$LOG")"
fail() { echo "$1" | tee -a "$LOG"; sleep 4; exit 1; }

# choose <prompt> <lines> → the chosen line (fzf, or a numbered list without it)
choose() {
  if command -v fzf >/dev/null; then
    printf '%s\n' "$2" | fzf --prompt="$1 " --height=100% --layout=reverse --no-multi \
      --header="type an id (123), or words from the title; Enter to confirm, Esc to cancel"
  else
    printf '%s\n' "$2" | nl -w2 -s'. ' >&2
    printf '%s ' "$1" >&2
    read -r n
    printf '%s\n' "$2" | sed -n "${n}p"
  fi
}

PROJECTS=$(devflow project list --json 2>/dev/null | jq -c '[.[] | select(.linearTeamId != null)]')
COUNT=$(printf '%s' "$PROJECTS" | jq 'length')
[ "$COUNT" -gt 0 ] || fail "No project has Linear configured."

if [ "$COUNT" -eq 1 ]; then
  PROJECT_NAME=$(printf '%s' "$PROJECTS" | jq -r '.[0].name')
else
  PROJECT_NAME=$(choose "Project:" "$(printf '%s' "$PROJECTS" | jq -r '.[].name')")
fi
[ -n "$PROJECT_NAME" ] || exit 0
PROJECT_PATH=$(printf '%s' "$PROJECTS" | jq -r --arg n "$PROJECT_NAME" '.[] | select(.name == $n) | .path')

echo "Loading $PROJECT_NAME issues…"
ISSUES=$(devflow project issues "$PROJECT_NAME" --json 2>/dev/null)
printf '%s' "$ISSUES" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1 \
  || fail "No Linear issues for $PROJECT_NAME."

LINE=$(choose "Issue:" "$(printf '%s' "$ISSUES" | jq -r '.[] | "\(.identifier)\t\(.title)"')")
[ -n "$LINE" ] || exit 0
IDENT=$(printf '%s' "$LINE" | cut -f1)
BRANCH=$(printf '%s' "$ISSUES" | jq -r --arg id "$IDENT" '.[] | select(.identifier == $id) | .branchName')

# herdr only creates worktrees from the workspace on the main checkout, not
# from one that is itself a worktree; find (or open) that parent workspace.
WS=$("$HERDR" api snapshot | jq -r --arg p "$PROJECT_PATH" \
  '.result.snapshot.workspaces[] | select(.worktree.checkout_path == $p and .worktree.is_linked_worktree == false) | .workspace_id' | head -1)
if [ -z "$WS" ]; then
  WS=$("$HERDR" workspace create --cwd "$PROJECT_PATH" --label "$PROJECT_NAME" --no-focus | jq -r '.result.workspace.workspace_id')
fi

echo "Creating worktree for $IDENT on $BRANCH…"
RESULT=$("$HERDR" worktree create --workspace "$WS" --branch "$BRANCH" --label "$IDENT" --focus 2>&1) || true
printf '%s\n' "$(date +%T) $IDENT $BRANCH → $RESULT" >> "$LOG"
PATH_CREATED=$(printf '%s' "$RESULT" | jq -r '.result.worktree.path // empty' 2>/dev/null)
[ -n "$PATH_CREATED" ] || fail "herdr refused: $(printf '%s' "$RESULT" | jq -r '.error.message // .' 2>/dev/null | head -c 300)"
echo "$PATH_CREATED"
echo "DevFlow is provisioning it (notification when ready)."
sleep 2
