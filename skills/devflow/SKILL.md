---
name: devflow
description: "DevFlow gives a git worktree what it needs to run: a seeded Postgres, ports, .env files, deps, dev servers. Use when working in a worktree of a project managed by DevFlow, when asked to create, provision, run, inspect or clean an environment, or to run several branches in parallel. Environments are LITE by default: nothing heavy runs until `devflow run`."
---

# DevFlow

An environment is a git worktree that DevFlow has provisioned. On top of the
checkout it adds a Postgres container, allocated ports, generated `.env` files,
dependencies and dev servers — and only when asked.

Each environment runs on its own ports, so several branches run at once without
colliding. `devflow list` shows them. There is no "active" environment.

## The rule that matters

**Creating a worktree costs nothing; provisioning costs minutes and RAM.**

A newly registered worktree is **LITE**: the checkout plus the main checkout's
`.env` files verbatim. Those point at the _main_ database and ports — fine for
reading code, running tests and generators, not for running the app. No
database, no ports, no deps.

It becomes **FULL** on the first `devflow run` or `devflow db`, which
provisions everything. So opening ten branches to read code does not start ten
Postgres containers.

## Commands (run in the worktree, or pass the env name)

```bash
devflow list --json                  # every environment: name, status, kind, ports, worktreePath
devflow provision [path] [--lite]    # register (lite) or fully provision a checkout
devflow create <project> <branch>    # cut the branch, make the worktree, provision it
devflow run [--apps web,api]         # dev servers in the foreground; provisions first if LITE
devflow env-files [env-name] [--all] # regenerate .env files (db + ports of the env); restart servers after
devflow db [--url]                   # lazysql on the env's Postgres (or print the URL)
devflow teardown [path]              # release database and ports, keep the checkout
devflow destroy <env-name> --yes     # everything, including the worktree
devflow start|stop <env-name>        # database container up / down
devflow kill-zombies [--dry-run]     # orphaned next/turbo/tsx/vite processes
devflow project issues <name> --json # open Linear issues with their branch names
devflow doctor                       # tools, database, projects, orphaned containers
```

`devflow run` holds the foreground and interleaves every app's output; Ctrl+C
stops them all.

## Database queries

No MCP server: use the CLI, it costs nothing per agent.

```bash
psql "$(devflow db --url)" -c "select count(*) from \"user\";"
psql "$(devflow db --url myapp-proj-123)" -Atc "select id, email from \"user\" limit 5;"
```

## Running several branches in parallel

1. `devflow project issues <project> --json` to map issue ids to branch names
   (when the project is connected to Linear).
2. Per branch: `git worktree add <path> -b <branch>` then
   `devflow provision <path> --lite`, which registers it in about a second
   without provisioning. (`devflow create` does both but always goes FULL.)
3. Let each worker call `devflow run` itself, only if it needs the app up.

## Gotchas

- After editing `.env` by hand, `devflow env-files` puts the environment's own
  database URL and ports back. Restart the dev servers afterwards — Next.js
  reads `NEXT_PUBLIC_*` at startup.
- `devflow db --url` works without lazysql installed; plain `devflow db` needs it.
- A FULL environment needs `pnpm` and Docker on PATH.

## herdr (optional)

When the [herdr](https://herdr.dev) plugin is linked, worktrees it creates are
registered LITE automatically, the sidebar shows status and ports
(`running api:3032 web:3031`), and:

- Close workspace → environment stopped (database down, data kept).
- Reopen worktree → environment started again.
- Remove worktree (`prefix+shift+u`) → `devflow teardown`, then herdr deletes
  the checkout.

None of this is required; every command above works on a plain worktree.
