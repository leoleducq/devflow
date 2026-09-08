#!/bin/sh
# workspace.focused → the port proxies point at this environment, if it is one.
set -eu
. "$(dirname "$0")/lib.sh"
WS=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '.workspace_id // .data.workspace_id // empty')
[ -n "$WS" ] || WS="${HERDR_WORKSPACE_ID:-}"
[ -n "$WS" ] || exit 0
CWD=$(workspace_cwd "$WS")
[ -n "$CWD" ] || exit 0
devflow activate --cwd "$CWD" --quiet
