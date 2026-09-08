#!/bin/sh
# Popup: the DevFlow cheat sheet inside herdr.
cat <<'TXT'
  DevFlow x herdr - prefix = ctrl+b

  ENVIRONMENTS
    New worktree (menu) + PROJ-123  new env from a Linear issue id
    prefix shift+l                  new env from a Linear issue (fzf picker)
    prefix t                        open an existing worktree (fzf) - env restarted
    Close (menu)                    env paused: database stopped, data kept
    prefix shift+u                  remove worktree + env (database, ports)
    prefix x                        destroy environments (fzf, Tab = multi-select)

  WORKING
    prefix r                        devflow run: dev servers in a tab
    prefix d                        lazysql on this environment's database
    prefix g                        lazygit
    prefix k                        kill zombie dev servers
    prefix a                        proxies point here (automatic on focus)

  MENU (bottom of the sidebar) -> DevFlow actions: provision, teardown, start, stop, activate
  Proxy: original app ports -> the active env; run `devflow proxy` as a daemon
  CLI: devflow list | provision | teardown | run | activate | db | kill-zombies | herdr sync

  prefix ?   full herdr help              Enter to close
TXT
read -r _
