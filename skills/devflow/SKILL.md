---
name: devflow
description: "DevFlow gives a git worktree what it needs to run: a seeded Postgres, ports, .env files, deps, dev servers. Use when working in a herdr workspace on a project managed by DevFlow, when asked to create, provision, run, inspect or clean an environment, or to run several issues in parallel. Environments are LITE by default: nothing heavy runs until `devflow run`."
---

# DevFlow

A herdr workspace on a git worktree IS an environment. herdr owns the checkout;
DevFlow adds database, ports, `.env`, deps and dev servers on top, and only
when asked.

## The rule that matters

**Creating a worktree costs nothing; provisioning costs minutes and RAM.**

- A new worktree (herdr "New worktree", `herdr worktree create`, or the
  `create_environment` MCP tool) is registered **LITE**: the checkout, the
  main checkout's `.env` files verbatim (they point at the _main_ database and
  ports: run tests and generators, not the app), no deps. Run `pnpm install`
  yourself if `node_modules` is missing. Nothing heavy happens.

## Commands (run in the worktree, or pass the env name)

```bash
devflow list --json                 # every environment: name, status, kind, ports, worktreePath
devflow provision [path] [--lite]   # register (lite) or fully provision a checkout
devflow run [--apps web,api]        # dev servers in the foreground; provisions first if LITE
devflow env-files [env-name] [--all] # regenerate .env files (db + ports of the env); restart servers after
devflow db [--url]                  # lazysql on the env's Postgres (or print the URL)
devflow teardown [path]             # release database and ports, keep the checkout
devflow kill-zombies [--dry-run]    # orphaned next/turbo/tsx/vite processes
devflow project issues <name> --json  # open Linear issues with their branch names
devflow start|stop <env-name>       # database container up / down
devflow destroy <env-name> --yes    # everything, including the worktree
```

Each environment runs on its own ports (`localhost:3031`, `3032`, …), listed
in `devflow list` and in the herdr sidebar (`running api:3032 web:3031`).
Cookies and Google sign-in work per env; there is no "active" env.

## Database queries

No MCP server: use the CLI, it costs nothing per agent.

```bash
psql "$(devflow db --url)" -c "select count(*) from \"user\";"
psql "$(devflow db --url myapp-proj-123)" -Atc "select id, email from \"user\" limit 5;"
```

## Running several issues in parallel

From a workspace on the project's main checkout:

1. `devflow project issues <project> --json` to map issue ids to branch names.
2. Per issue: `herdr worktree create --workspace "$HERDR_WORKSPACE_ID" --branch <branchName> --label <ID> --no-focus`
   (DevFlow registers it LITE within a second).
3. `herdr agent start <id-slug> --kind claude --pane <root pane of the new workspace>`,
   then `herdr agent prompt … --wait`, `herdr agent read …`.
4. Let each worker call `devflow run` itself only if it needs the app up.

## Lifecycle in herdr

- Close workspace → environment stopped (database down, data kept).
- Reopen worktree → environment started again.
- Remove worktree (`prefix+shift+u`) → `devflow teardown`, then herdr deletes the checkout.
