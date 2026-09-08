# Shared helpers for the DevFlow herdr plugin (POSIX sh).
HERDR="${HERDR_BIN_PATH:-herdr}"

notify() { # notify <body> [done|request]
  "$HERDR" notification show "DevFlow" --body "$1" --sound "${2:-done}" >/dev/null 2>&1 || true
}

# Checkout directory of a workspace. herdr puts it in the invocation context;
# fall back to the cwd of the workspace's first pane.
workspace_cwd() { # workspace_cwd <workspace_id>
  CTX_CWD=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | jq -r --arg ws "$1" \
    'select(.workspace_id == $ws) | .workspace_cwd // empty' 2>/dev/null)
  if [ -n "$CTX_CWD" ]; then printf '%s' "$CTX_CWD"; return; fi
  "$HERDR" pane list --workspace "$1" 2>/dev/null | jq -r '.result.panes[0].cwd // empty'
}

# `devflow` must resolve even when herdr's server was started by launchd.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
