#!/bin/sh
# Popup: open an existing worktree of the current project as a workspace,
# picked with fzf (branch, DevFlow status, path). DEVFLOW_PICK=<text> picks
# without fzf, for tests.
set -eu
. "$(dirname "$0")/lib.sh"

choose() { # choose <prompt> <lines> → chosen line
  if [ -n "${DEVFLOW_PICK:-}" ]; then printf '%s\n' "$2" | grep -m1 -- "$DEVFLOW_PICK"; return; fi
  printf '%s\n' "$2" | fzf --prompt="$1 " --height=100% --layout=reverse --no-multi --delimiter='\t' --with-nth=1,2 \
    --header="type a branch or an id; Enter to open, Esc to cancel"
}

# Repository of the workspace the popup was opened from; else ask for a project.
CWD=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | jq -r '.workspace_cwd // empty')
ROOT=""
[ -n "$CWD" ] && ROOT=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##' || true)
if [ -z "$ROOT" ]; then
  PROJECTS=$(devflow project list --json 2>/dev/null)
  LINE=$(choose "Project:" "$(printf '%s' "$PROJECTS" | jq -r '.[] | "\(.name)\t\t\(.path)"')") || exit 0
  ROOT=$(printf '%s' "$LINE" | cut -f3)
fi
[ -n "$ROOT" ] || exit 0

ENVS=$(devflow list --json 2>/dev/null || echo '[]')
LIST=$(git -C "$ROOT" worktree list --porcelain | awk '
  /^worktree /{path=substr($0,10)} /^branch /{branch=substr($0,8); sub("refs/heads/","",branch)}
  /^$/{ if (path!="") print path "\t" branch; path=""; branch="" }
  END{ if (path!="") print path "\t" branch }' \
  | grep -v "^$ROOT	" \
  | while IFS="$(printf '\t')" read -r path branch; do
      status=$(printf '%s' "$ENVS" | jq -r --arg p "$path" '.[] | select(.worktreePath == $p) | .status' | head -1)
      printf '%s\t%s\t%s\n' "$branch" "${status:-"-"}" "$path"
    done)
[ -n "$LIST" ] || { echo "No worktree in $ROOT."; sleep 2; exit 0; }

LINE=$(choose "Worktree:" "$LIST") || exit 0
[ -n "$LINE" ] || exit 0
TARGET=$(printf '%s' "$LINE" | cut -f3)

PARENT=$("$HERDR" api snapshot | jq -r --arg p "$ROOT" \
  '.result.snapshot.workspaces[] | select(.worktree.checkout_path == $p and .worktree.is_linked_worktree == false) | .workspace_id' | head -1)
[ -n "$PARENT" ] || PARENT=$("$HERDR" workspace create --cwd "$ROOT" --label "$(basename "$ROOT")" --no-focus | jq -r '.result.workspace.workspace_id')

"$HERDR" worktree open --workspace "$PARENT" --path "$TARGET" --focus | jq -r '.result.workspace.workspace_id // .error.message'
