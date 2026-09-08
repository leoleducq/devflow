#!/bin/sh
# Run a devflow command in the checkout of the workspace the action targets.
# Pseudo-commands (start-here, …) resolve the environment from the cwd first.
set -eu
. "$(dirname "$0")/lib.sh"
CWD=$(workspace_cwd "${HERDR_WORKSPACE_ID:-}")
[ -n "$CWD" ] || { notify "No workspace in context" request; exit 1; }
cd "$CWD"
shift # "devflow"
CMD="$1"; shift

env_name() { devflow list --json 2>/dev/null | jq -r --arg p "$CWD" '.[] | select(.worktreePath == $p) | .name' | head -1; }

case "$CMD" in
  provision) OUT=$(devflow provision "$CWD" "$@" 2>&1) && notify "$(printf '%s' "$OUT" | tail -1)" || { notify "$(printf '%s' "$OUT" | tail -1)" request; exit 1; } ;;
  teardown)  devflow teardown "$CWD" && notify "Environment released" ;;
  activate-here) devflow activate --cwd "$CWD" && notify "Proxies point here" ;;
  start-here) N=$(env_name); [ -n "$N" ] && devflow start "$N" && notify "$N started" ;;
  stop-here)  N=$(env_name); [ -n "$N" ] && devflow stop "$N" && notify "$N stopped" ;;
  run) exec devflow run ;;
  db) exec devflow db ;;
  kill-zombies) OUT=$(devflow kill-zombies 2>&1); notify "$(printf '%s' "$OUT" | tail -1)" ;;
  *) exec devflow "$CMD" "$@" ;;
esac
