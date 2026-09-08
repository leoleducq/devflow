#!/bin/sh
# Popup: pick environments (fzf, multi-select with Tab) and destroy them:
# processes, database, ports, herdr workspace and the git worktree.
set -eu
. "$(dirname "$0")/lib.sh"

ENVS=$(devflow list --json 2>/dev/null)
printf '%s' "$ENVS" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1 || { echo "No environments."; sleep 2; exit 0; }

PICKED=$(printf '%s' "$ENVS" | jq -r '.[] | "\(.name)\t\(.status)\t\(.branch)"' \
  | fzf --multi --prompt="Destroy: " --height=100% --layout=reverse \
      --header="Tab to select several, Enter to destroy, Esc to cancel" \
  | cut -f1) || true
[ -n "$PICKED" ] || exit 0

echo "$PICKED" | while read -r NAME; do
  [ -n "$NAME" ] || continue
  echo "Destroying $NAME…"
  devflow destroy "$NAME" --yes 2>&1 | tail -1
done
notify "Environments cleaned"
sleep 2
