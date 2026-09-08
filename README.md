# devflow

One isolated dev environment per branch — seeded Postgres, allocated ports, generated `.env` files, dependencies, dev servers. Built for coding agents, and for the humans who supervise them.

## Setup, by your coding agent

Paste this into Claude Code, Codex, Cursor, pi or any coding agent, from your project directory:

```text
Install devflow by running `npm install -g @iziatask/devflow`, then
`devflow setup-agents -y` so you can use it, then `devflow init -y` from
this directory to register the project. Finally, read the output of
`devflow skill` and tell me what you can now do with it.
```

No manual step. `setup-agents` writes the DevFlow skill into every coding agent on the machine, `init` detects this project's apps, ports and dev commands and registers it, and `devflow skill` prints that same skill to stdout so the agent picks it up in the session it is already in. The `-y` flags are load-bearing: an agent runs commands with a piped stdin, and both would otherwise stop to ask.

Already have devflow installed, and just want the agent in front of you to learn it?

```text
Run `devflow skill` and follow it.
```

The human path is the same commands without the prose:

```bash
npm install -g @iziatask/devflow
cd ~/code/myapp
devflow init      # detect this project's apps, ports and dev commands; register it
devflow provision # give this checkout ports, a database and .env files
devflow run       # dev servers, in the foreground
```

## Why

Your branch gets a worktree in a second. What it does not get is a database of its own, free ports, `.env` files pointing at those ports, or a dev server — so the second branch collides with the first.

```console
$ devflow create myapp feat/checkout
✔ Provisioning git worktree
✔ Allocating ports
✔ Spinning up database container
✔ Installing dependencies
✔ Generating .env files
✔ Seeding database

$ devflow list
NAME            STATUS   PROJECT  BRANCH         DB     PORTS
feat-checkout   RUNNING  myapp    feat/checkout  :5433  web:3010 api:3011
fix-webhooks    STOPPED  myapp    fix/webhooks   :5434  web:3020 api:3021
```

Two branches, two Postgres containers, two sets of ports, two sets of `.env` files. Neither knows the other exists. The database URL is swapped and every `localhost:<port>` is rewritten, so `NEXT_PUBLIC_API_URL`, CORS lists and OAuth callbacks reach the right app. Seed from your main database, your Prisma migrations, or a snapshot. Dev servers run in one foreground terminal with interleaved output; `Ctrl+C` stops them all.

## Quick start

```bash
devflow create myapp feat/login   # branch + worktree + ports + database + deps
devflow create myapp --pr 412     # …or straight from a GitHub pull request
cd .devflow/worktrees/feat-login
devflow run                       # dev servers
devflow logs --errors             # what they printed, from any terminal
devflow db query "select count(*) from users"
devflow destroy feat-login --yes  # worktree and database gone
```

Already made the worktree yourself with `git worktree add`? `devflow provision` adopts it.

### LITE and FULL — the one concept to know

Creating a worktree costs nothing. Provisioning one costs minutes and a gigabyte of RAM. DevFlow keeps them separate:

| | LITE | FULL |
|---|---|---|
| `.env` files | copied from the main checkout | generated for this environment |
| Allocated ports | — | one per app |
| Postgres container | — | started and seeded |
| Dependencies installed | optional | yes |
| Costs | ~1 second | minutes |

A checkout registered with `devflow create --lite` or `devflow provision --lite` is **LITE**, and is promoted to **FULL** automatically by the first `devflow run` or `devflow db` — or on purpose, with `devflow promote --seed <strategy>`. So opening ten branches to read code does not start ten Postgres containers, and you never have to remember to provision.

## For coding agents

`devflow setup-agents` writes one file, `devflow/SKILL.md`, into the global skills directory of each agent it finds — Claude Code, Cursor, Gemini CLI, Amp, opencode, goose, Factory droid, pi, Codex, plus the shared `~/.agents/skills` that Cline, Warp and Zed read. Directories that do not exist are skipped, nothing else in them is touched, and `--uninstall` removes exactly what DevFlow wrote. `--status` reports without writing, `--dry-run` previews, `--scope project` installs into this checkout's `.agents/skills`.

**Logs survive the process that wrote them.** `devflow run` persists its dev servers' interleaved output to `~/.devflow/logs/<environment-id>.jsonl` as well as to the terminal, and that file is what `devflow logs` reads. The `run` in a herdr pane and the `logs` in an agent's shell are different processes sharing nothing but the filesystem, so an agent can read the stderr of a server it never started — `devflow logs --errors -n 50` after a failed request, instead of asking a human what the terminal said.

**`--json` on everything that returns data.** One JSON value on stdout and nothing else — no spinner, no progress, no human summary. Failures go to stderr in one stable shape, with a non-zero exit code:

```json
{ "ok": false, "error": { "code": "NOT_AN_ENVIRONMENT", "message": "…" } }
```

`code` is the half you branch on; messages stay free to be reworded. The codes are `NOT_AN_ENVIRONMENT`, `ENVIRONMENT_NOT_FOUND`, `PROJECT_NOT_FOUND`, `ENVIRONMENT_NOT_RUNNING`, `NO_DATABASE`, `DOCKER_UNAVAILABLE`, `TOOL_MISSING`, `INVALID_ARGUMENT`, `CONFIRMATION_REQUIRED`, `INPUT_REQUIRED` and `UNKNOWN`.

**Nothing hangs.** With stdin a silent pipe — which is what an agent gives a subprocess — prompt libraries wait forever, and a hung provision is worse than a failed one. DevFlow decides whether it may prompt *before* building one: under `--json`, `--yes`, `CI`, or a non-TTY it fails immediately, naming the flag that would have answered the question. Every prompt has a flag. (`devflow run --json` is the one exception to one-value-on-stdout: it holds the foreground, so it prints the environment and its ports as a single JSON line, then streams the servers' output.)

## Commands

`devflow --help` groups these the same way; `devflow <command> --help` documents one.

| Command | What it does | `--json` |
|---|---|:---:|
| **Setting up** | | |
| `init [path]` | Prerequisites, detection, registration. `-y` accepts everything detected | ✅ |
| `doctor` | Check tools, state database, projects, orphaned containers | ✅ |
| `setup-agents` | Install the skill into the agents here. `--status` `--dry-run` `--uninstall` `--all` `--only <ids>` `--scope user\|project` `-y` | ✅ |
| `skill` | Print the DevFlow agent skill (SKILL.md) | ✅ |
| **Every day** | | |
| `run [env]` | Dev servers in the foreground; promotes LITE first. `--apps` | ✅ |
| `status [env]` | The active environment and what is running. `--all` for the machine | ✅ |
| `list` (`ls`) | Every environment: status, kind, ports, worktree. `-p <project>` | ✅ |
| `ps [env]` | Dev servers, one row each. `start <app>` `stop <app>\|--all` `restart <app>` `stop-all` | ✅ |
| `logs [env]` | What the dev servers printed. `--app` `--errors` `-f` `-n <lines>` | ✅ |
| `db [env]` | lazysql on its Postgres. `--url` prints the connection string | ✅ |
| `db query "<sql>"` | Run SQL against it. `-f <file>` `-e <env>` | ✅ |
| `db snapshot <name>` / `db snapshots` | Dump it for `--seed snapshot:<name>` / list what you have | ✅ |
| **Environments** | | |
| `create <project> [branch]` | Branch, worktree, ports, database, deps. `--pr <n>` `--base` `--seed` `--apps` `--lite` `--skip-install` | ✅ |
| `provision [path]` | Adopt an existing checkout. `--lite` `--apps` `--seed` `--base` `--skip-install` | ✅ |
| `promote [env]` | Give a LITE environment its ports and database. `--seed` `--apps` | ✅ |
| `diff [env]` | What it changed against its base. `--uncommitted` `--stat` | ✅ |
| `history [env]` | The commits it added on top of its base. `--patch` `-n` | ✅ |
| `start [env]` / `stop [env]` | Database container up / down | ✅ |
| `teardown [path]` | Release database and ports, keep the checkout. `--name` `--quiet` | ✅ |
| `destroy <env>` | Everything, worktree included. `-y` | ✅ |
| `env-files [env]` | Regenerate `.env` files. `--all` | ✅ |
| `activate [env]` | Point the port proxies at it. `--none` `--show` `--cwd` `--quiet` | ✅ |
| **Projects and config** | | |
| `project add\|list\|get\|inspect\|remove` | Register and inspect projects | ✅ |
| `project prs <name>` / `project branches <name>` | Open pull requests (needs `gh`) / local branches, to feed `create` | ✅ |
| `project set <name>` / `project linear\|issues` | Configure a project / Linear | linear, issues |
| `config get\|set` | DevFlow's global settings | ✅ (`get`) |

Also: `template list\|add\|remove\|new <name> [template]` (scaffold a project from a template repo, optionally creating the GitHub repo with `--github`), `proxy` (port-forwarding daemon), `studio <env>` (Prisma Studio), `kill-zombies` (orphaned next/turbo/tsx/vite processes), `herdr sync`, `completion <shell>`.

`project set` writes every field, so a CLI-only setup is never missing anything: `--apps`, `--default-apps`, `--app-ports web:3000,api:3005`, `--dev-commands`, `--default-base-branch`, `--db-env-var-name`, `--db-docker-image`, `--default-seed`, `--source-database-url` and the Linear fields. `--app-ports` matters most — the proxy and the `.env` port rewriting both depend on it; `devflow init` fills it in from your `dev` scripts, `.env.example` and `docker-compose.yml`, and `project inspect --apply` re-detects it later. Global settings (`config set <field> <value>`): `portRangeStart`, `portRangeSize`, `dbDefaultPort`, `dbSeedStrategy`, `worktreeLocation`, `dockerNetwork`, `dockerVolumePrefix`.

## How it works

**Ports and `.env`.** Each app draws one port from a configurable range (`portRangeStart` 3000, `portRangeSize` 100), recorded per environment so two never collide. Every `.env` in the main checkout is copied into the worktree with the database variable repointed, `PORT=` set, and every `http://localhost:<original>` rewritten. `devflow run` regenerates them before starting, because agents copy `.env` files around.

**Seeding** (`--seed`, or the project's `--default-seed`). `copy-main` dumps your source database (`--source-database-url`) and restores it; `fresh` runs your Prisma migrations and seed onto an empty one; `snapshot:<name>` restores a dump `devflow db snapshot <name>` wrote earlier into `~/.devflow/snapshots` — a name with a `/` is taken as a path instead, so a dump can live next to the code that needs it. Missing snapshots are rejected up front, not after five minutes of provisioning. `pg_dump` and `psql` run inside Docker at the source server's own major version, so host client versions never mismatch. A project with neither a source database nor a Prisma schema gets an empty database, which is often exactly right.

**State.** One SQLite file: `$DEVFLOW_HOME/devflow.db`, else `$XDG_DATA_HOME/devflow/devflow.db`, else `~/.devflow/devflow.db`. Created and migrated on first use; there is no setup step. Your projects' own data lives in the Postgres containers, never there.

**The proxy.** When you need your project's *original* ports (say 3000 and 3005) to reach one particular environment — an OAuth callback, a webhook, muscle memory — run `devflow proxy` as a daemon and aim it with `devflow activate [env]` (`--none` to forward nowhere, `--show` to ask which one it is pointing at).

## Linear (optional)

```bash
devflow project linear myapp --team ENG   # or omit --team to pick from a list
devflow project issues myapp              # PROJ-123  Fix the thing  leo/proj-123-fix-the-thing
devflow create myapp leo/proj-123-fix-the-thing
```

Branch names come from Linear, so the environment's branch links itself back to the issue. `--api-key`, `--team` and `--project` make the connection scriptable; without them it prompts. `project set` also takes `--linear-exclude-states` and `--linear-filter-labels` to narrow what `issues` shows. GitHub needs no configuration: `project prs` lists open pull requests through `gh`, and `devflow create <project> --pr <n>` takes the branch, base, title and URL from one.

## herdr (optional)

DevFlow works standalone. If you use [herdr](https://herdr.dev), a terminal multiplexer that owns git worktrees:

```bash
herdr plugin link "$(npm root -g)/@iziatask/devflow/herdr-plugin.toml"
devflow herdr sync
```

You get a workspace per project, status and ports as sidebar tokens, new worktrees registered LITE automatically, environments stopped and started with their workspace, `teardown` before a worktree is removed, popup pickers for Linear issues, and `activate` following the workspace you focus.

## Requirements

**Node.js 20+** and **git**, plus **Docker** for environment databases (LITE environments work without it). Optional: `lazysql` for `devflow db` (`--url` and `db query` work without it), `gh` for `create --pr` and `project prs`, `psql` for querying a database by hand, [herdr](https://herdr.dev). Installing runs `prisma generate`, which builds a platform-specific query engine, so the first install needs network access. `devflow doctor` reports what is missing; `npx @iziatask/devflow doctor` tries it without installing.

**Known limitations.** Developed and tested on **macOS**; Windows is not supported. FULL environments install dependencies and start dev servers with **pnpm**. Detection is best on turborepo-style monorepos (`apps/*/package.json`, `.env.example`, `docker-compose.yml`); other layouts register fine, you just fill more in with `project set`. Port rewriting in `.env` files covers `PORT=` and `localhost:<port>` URLs — a bare `WEB_PORT=3000` is left alone.

## Contributing

```bash
git clone https://github.com/leoleducq/devflow.git && cd devflow
npm install && npm run build && npm run check-types
node bin/devflow.js --help
```

`run`, `provision`, `create` and `start` do real things — containers, ports, `pnpm install` — so point `DEVFLOW_HOME` at a scratch path while developing (`DEVFLOW_HOME=/tmp/scratch node bin/devflow.js list`), and test `setup-agents` with `--dry-run` or a fake `HOME`. See [AGENTS.md](AGENTS.md) for the layout and conventions.

The Prisma client is generated at install time rather than shipped, because the query engine is a platform-specific binary — hence `prisma` as a runtime dependency, `prisma/` inside the package, and a `postinstall`.

Issues and pull requests: [github.com/leoleducq/devflow](https://github.com/leoleducq/devflow).

## License

MIT
