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

## Machine-readable output

Add `--json` to any command that returns data: `list`, `status`, `doctor`,
`provision`, `create`, `promote`, `start`, `stop`, `teardown`, `destroy`,
`activate`, `ps`, `logs`, `diff`, `history`, `db`, `db query`, `db snapshot`,
`db snapshots`, `env-files`, `kill-zombies`, `config get`, `skill`,
`setup-agents`, `init`, `template list|add|remove|new`, and
`project list|get|inspect|issues|linear|add|remove|prs|branches`.

The contract: one JSON value on stdout, nothing else. A failure prints
`{"ok": false, "error": {"code", "message"}}` on **stderr** and exits non-zero.
Branch on `code`, not on the message:

`NOT_AN_ENVIRONMENT` · `ENVIRONMENT_NOT_FOUND` · `PROJECT_NOT_FOUND` ·
`ENVIRONMENT_NOT_RUNNING` · `NO_DATABASE` · `DOCKER_UNAVAILABLE` ·
`TOOL_MISSING` · `INVALID_ARGUMENT` · `CONFIRMATION_REQUIRED` ·
`INPUT_REQUIRED` · `UNKNOWN`

## DevFlow never blocks on a prompt

When stdin is not a terminal — which is every agent, pipe and CI run —
DevFlow does not ask questions. It either uses the value you passed, or fails
straight away with `INPUT_REQUIRED` (or `CONFIRMATION_REQUIRED`) naming the
flag that would have answered it. Nothing hangs waiting for input.

So if a command reports `INPUT_REQUIRED`, read the message: it tells you the
exact flag to add. Destructive commands need `--yes`.

```bash
devflow init --name myapp --apps web,api -y      # register without any question
devflow project linear myapp --api-key "$LINEAR_API_KEY" --team ENG --json
devflow destroy <env-name> --yes                 # confirmation, non-interactively
devflow setup-agents --yes                       # or --dry-run to see the plan first
```

## Commands (run in the worktree, or pass the env name)

```bash
devflow status [env-name] [--all]    # this environment, or the machine + which env the proxies point at
devflow list --json                  # every environment: name, status, kind, ports, worktreePath
devflow provision [path] [--lite]    # register (lite) or fully provision a checkout
devflow create <project> <branch>    # cut the branch, make the worktree, provision it
devflow create <project> --pr <n>    # same, with the branch, base, title and URL taken from a GitHub PR
devflow promote [env-name]           # give a LITE environment its ports, database and deps now
devflow run [--apps web,api]         # dev servers in the foreground; provisions first if LITE
devflow ps [env-name]                # what is running, per app, with its pid and port
devflow ps start|stop|restart <app>  # control one app without touching the others
devflow ps stop-all                  # stop the dev servers of every environment
devflow logs [--app api] [--errors]  # what the dev servers printed; -f follows
devflow diff [--uncommitted] [--stat]# what this environment changed against its base branch
devflow history [--patch]            # the commits it added on top of that base
devflow env-files [env-name] [--all] # regenerate .env files (db + ports of the env); restart servers after
devflow db [--url] [--json]          # lazysql on the env's Postgres (or print the URL / connection details)
devflow db query "<sql>" [--json]    # run SQL against the environment's database
devflow db snapshot <name>           # pg_dump it, for `--seed snapshot:<name>` later
devflow teardown [path]              # release database and ports, keep the checkout
devflow destroy <env-name> --yes     # everything, including the worktree
devflow start|stop [env-name]        # database container up / down
devflow activate [env-name|--show|--none]  # which environment the original ports forward to
devflow kill-zombies [--dry-run]     # orphaned next/turbo/tsx/vite processes
devflow project prs <name> --json    # open pull requests, with the number `create --pr` takes
devflow project branches <name>      # local branches, newest commit first
devflow project issues <name> --json # open Linear issues with their branch names
devflow project linear <name> --api-key <key> --team <id|key> [--project <id|name>] [--json]
devflow template new <name> <repo>   # scaffold a project from a template and register it
devflow completion zsh|bash|fish     # shell completion script on stdout
devflow doctor --json                # tools, database, projects, orphaned containers
```

`devflow run` holds the foreground and interleaves every app's output; Ctrl+C
stops them all. `devflow run --json` prints the resolved environment and its
ports as one JSON object *first*, then streams — use it to learn which port to
hit before the logs start.

## Database queries

No MCP server: use the CLI, it costs nothing per agent.

```bash
devflow db query "select count(*) from \"user\"" --json
devflow db query "update \"user\" set credits = 100 where email = 'a@b.c'"
devflow db query --file seed.sql --env myapp-proj-123
psql "$(devflow db --url)" -c "select count(*) from \"user\";"    # or use psql directly
```

`devflow db query --json` returns `{command, rowCount, fields, rows}`. It is
the environment's own throwaway database, so writes are not gated.

`devflow db --url` provisions a LITE environment first — it has no database
until then. To read the connection host, port and user separately, use
`devflow db --json`.

## Working on a pull request

```bash
devflow project prs myapp --json                 # numbers, branches, and which already have an env
devflow create myapp --pr 412                    # branch, base, title and URL come from the PR
devflow diff --stat                              # what the PR changes, against its real base
devflow logs --errors                            # why it is failing, once the servers are up
```

`--pr` needs `gh` installed and authenticated; `devflow doctor` reports it.

## Reading what the dev servers printed

`devflow run` writes every line to `~/.devflow/logs/<env>.jsonl` as well as to
its own stdout, so another pane can read them:

```bash
devflow logs --errors -n 50      # stderr only: what crashed
devflow logs --app api -f        # follow one app
devflow logs --json -n 200       # entries as {timestamp, app, stream, text}
```

An environment that has never been run has no logs.

## Running several branches in parallel

1. `devflow project issues <project> --json` to map issue ids to branch names
   (when the project is connected to Linear).
2. Per branch: `git worktree add <path> -b <branch>` then
   `devflow provision <path> --lite`, which registers it in about a second
   without provisioning. (`devflow create` does both but always goes FULL.)
3. Let each worker call `devflow run` itself, only if it needs the app up.

## What not to do

- **Do not provision to read code.** A LITE worktree already has the source
  and the main checkout's `.env`. `devflow provision <path> --lite`, or no
  DevFlow at all, is the right move for reading, grepping and typechecking.
- **Do not run `devflow kill-zombies` blindly.** It kills dev servers with no
  owning `devflow run`. Check with `--dry-run --json` first and read the
  command lines: another agent's foreground server is not a zombie.
- **Do not edit an environment's `.env` by hand** and expect it to stick.
  `devflow run` regenerates them on every start. Change the project's settings
  (`devflow project set`) or the main checkout's `.env` instead.
- **Do not use `devflow destroy` to free RAM.** It deletes the worktree and
  the branch's database. `devflow stop` puts the environment to sleep and
  keeps the data; `devflow teardown` releases the database and ports but keeps
  the checkout.
- **Do not assume ports.** They are allocated per environment. Read them from
  `devflow list --json` or `devflow run --json`.

## Gotchas

- After editing `.env` by hand, `devflow env-files` puts the environment's own
  database URL and ports back. Restart the dev servers afterwards — Next.js
  reads `NEXT_PUBLIC_*` at startup.
- `devflow db --url` works without lazysql installed; plain `devflow db` needs it.
- A FULL environment needs `pnpm` and Docker on PATH. `devflow doctor --json`
  says which of them is missing.
- `devflow list --json` and `project get --json` mask stored secrets as
  `"[redacted]"`; they are not a way to read an API key back.

## herdr (optional)

When the [herdr](https://herdr.dev) plugin is linked, worktrees it creates are
registered LITE automatically, the sidebar shows status and ports
(`running api:3032 web:3031`), and:

- Close workspace → environment stopped (database down, data kept).
- Reopen worktree → environment started again.
- Remove worktree (`prefix+shift+u`) → `devflow teardown`, then herdr deletes
  the checkout.

None of this is required; every command above works on a plain worktree.
