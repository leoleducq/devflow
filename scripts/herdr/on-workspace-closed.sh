#!/bin/sh
# workspace.closed → stop the environment on that checkout (database container
# down, data kept). Reopening the worktree starts it again.
set -eu
. "$(dirname "$0")/lib.sh"
CWD=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '.workspace.worktree.checkout_path // .data.workspace.worktree.checkout_path // empty')
[ -n "$CWD" ] || exit 0
NAME=$(devflow list --json 2>/dev/null | jq -r --arg p "$CWD" '.[] | select(.worktreePath == $p and .status == "RUNNING") | .name' | head -1)
[ -n "$NAME" ] || exit 0
devflow stop "$NAME" >/dev/null 2>&1 && notify "$NAME stopped (workspace closed)"
