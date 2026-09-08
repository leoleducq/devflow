#!/bin/sh
# worktree.created → provision it; worktree.removed → release its resources.
# The event carries the checkout path; DevFlow finds the project from git.
set -eu
. "$(dirname "$0")/lib.sh"
EVENT="$1"
WORKTREE=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '.worktree.path // .data.worktree.path // empty')
[ -n "$WORKTREE" ] || exit 0

# Typing a Linear id (PROJ-123) as the branch in herdr's "New worktree":
# swap it for the issue's real branch and name the workspace after the issue.
adopt_linear_id() { # adopt_linear_id <worktree> <workspace_id>
  BRANCH=$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  printf '%s' "$BRANCH" | grep -Eq '^[A-Za-z]{2,6}-[0-9]+$' || return 0
  IDENT=$(printf '%s' "$BRANCH" | tr '[:lower:]' '[:upper:]')
  ROOT=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')
  PROJECT=$(devflow project list --json 2>/dev/null | jq -r --arg p "$ROOT" '.[] | select(.path == $p and .linearTeamId != null) | .name' | head -1)
  [ -n "$PROJECT" ] || return 0
  LINEAR_BRANCH=$(devflow project issues "$PROJECT" --json 2>/dev/null | jq -r --arg id "$IDENT" '.[] | select(.identifier == $id) | .branchName' | head -1)
  [ -n "$LINEAR_BRANCH" ] || { notify "$IDENT: not an open issue of $PROJECT" request; return 0; }
  git -C "$1" branch -m "$LINEAR_BRANCH" >/dev/null 2>&1 || return 0
  [ -n "$2" ] && "$HERDR" workspace rename "$2" "$IDENT" >/dev/null 2>&1 || true
}

case "$EVENT" in
  created)
    WS_ID=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '.workspace.workspace_id // .data.workspace.workspace_id // empty')
    adopt_linear_id "$WORKTREE" "$WS_ID"
    # Lite: register only. Ports, database and deps come with the first
    # `devflow run` (or the "provision" action) so five new worktrees do not
    # start five installs and five Postgres at once.
    if OUT=$(devflow provision "$WORKTREE" --lite 2>&1); then
      :
    else
      # herdr keeps stderr in `herdr plugin log list`, so the full output lands there.
      printf '%s\n' "$OUT" >&2
      notify "Provision failed: $(printf '%s' "$OUT" | tail -1)" request
      exit 1
    fi
    ;;
  opened)
    # A worktree opened again after its workspace was closed: wake its env.
    NAME=$(devflow list --json 2>/dev/null | jq -r --arg p "$WORKTREE" '.[] | select(.worktreePath == $p and .status == "STOPPED") | .name' | head -1)
    [ -n "$NAME" ] && devflow start "$NAME" >/dev/null 2>&1 && notify "$NAME started"
    devflow herdr sync >/dev/null 2>&1 || true
    ;;
  removed)
    devflow teardown "$WORKTREE" --quiet
    ;;
esac
