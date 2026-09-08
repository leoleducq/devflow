# devflow

One isolated dev environment per branch — seeded Postgres, allocated ports, generated `.env` files, dependencies, dev servers. For humans and for coding agents.

Your branch gets a worktree in a second. What it does not get is a database of its own, free ports, `.env` files pointing at those ports, or a running dev server — so the second branch collides with the first. DevFlow gives each worktree its own.

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

$ devflow run
feat-checkout
  web: http://localhost:3010
  api: http://localhost:3011
Ctrl+C stops all services
```

Two branches, two Postgres containers, two sets of ports, two sets of `.env` files. Neither knows the other exists.

```bash
npm install -g @iziatask/devflow
cd ~/code/myapp
devflow init      # detect this project's apps, ports and dev commands; register it
devflow provision # give this checkout ports, a database and .env files
devflow run       # dev servers, in the foreground
```

## Why

- **Parallel branches stop colliding.** Every environment gets its own database, its own ports and its own `.env` files. Five branches run at once.
- **`.env` files that actually point at this environment.** The database URL is swapped and every `localhost:<port>` is rewritten, so `NEXT_PUBLIC_API_URL`, CORS lists and OAuth callbacks reach the right app.
- **Cheap by default.** A new worktree is registered in about a second. Nothing heavy runs until you ask it to.
- **Real seeded data.** Copy your main database, run your Prisma migrations, or restore a snapshot.
- **One terminal for every app.** Dev servers run in the foreground with interleaved output; `Ctrl+C` stops them all.
- **Built for agents.** Every command that returns data speaks `--json`, and nothing ever hangs waiting for a prompt that will not come.

## Install

```bash
npm install -g @iziatask/devflow          # the usual way; gives you the `devflow` binary
npx @iziatask/devflow doctor              # try it without installing
npm install -g github:leoleducq/devflow   # straight from git
```

Installing runs `prisma generate`, which builds a platform-specific query engine, so the first install needs network access. Confirm with `devflow doctor`.

## Quick start

```bash
devflow init                      # register the project in this directory
devflow create myapp feat/login   # branch + worktree + ports + database + deps
cd .devflow/worktrees/feat-login
devflow run                       # dev servers
devflow db                        # lazysql on this environment's Postgres
devflow destroy feat-login --yes  # worktree and database gone
```

Already made the worktree yourself with `git worktree add`? `devflow provision` adopts it.

### LITE and FULL — the one concept to know

Creating a worktree costs nothing. Provisioning one costs minutes and a gigabyte of RAM. DevFlow keeps them separate:

| | LITE | FULL |
|---|---|---|
| Registered in DevFlow | yes | yes |
| `.env` files | copied from the main checkout | generated for this environment |
| Allocated ports | — | one per app |
| Postgres container | — | started and seeded |
| Dependencies installed | optional | yes |
| Costs | ~1 second | minutes |

A checkout registered with `devflow provision --lite` is **LITE**. It is promoted to **FULL** automatically by the first `devflow run` or `devflow db`. So opening ten branches to read code does not start ten Postgres containers, and you never have to remember to provision — the command that needs a database provisions one.

## For coding agents

Most of DevFlow's users are agents, so the CLI is built for them rather than retrofitted.

**Install the skill for every agent on this machine:**

```bash
devflow setup-agents            # detects installed agents, installs devflow/SKILL.md into each
devflow setup-agents --status   # what is installed where, writing nothing
devflow setup-agents --dry-run  # what would change
```

It writes one file, `devflow/SKILL.md`, into the global skills directory of each agent it finds — Claude Code, Cursor, Gemini CLI, Amp, opencode, goose, Factory droid, pi, Codex, plus the shared `~/.agents/skills` that Cline, Warp and Zed read. Directories that do not exist are skipped, nothing else in them is touched, and `--uninstall` removes exactly what DevFlow wrote. `--scope project` installs into this checkout's `.agents/skills` instead.

**Zero-install:** `devflow skill` prints the same SKILL.md to stdout. Pipe it wherever your agent reads skills, or just read it.

**`--json` on everything that returns data.** One JSON value on stdout and nothing else — no spinner, no progress, no human summary. Failures go to stderr in one stable shape, with a non-zero exit code:

```json
{ "ok": false, "error": { "code": "NOT_AN_ENVIRONMENT", "message": "…" } }
```

`code` is the half you branch on; messages stay free to be reworded. The codes are `NOT_AN_ENVIRONMENT`, `ENVIRONMENT_NOT_FOUND`, `PROJECT_NOT_FOUND`, `ENVIRONMENT_NOT_RUNNING`, `NO_DATABASE`, `DOCKER_UNAVAILABLE`, `TOOL_MISSING`, `INVALID_ARGUMENT`, `CONFIRMATION_REQUIRED`, `INPUT_REQUIRED` and `UNKNOWN`.

**Nothing hangs.** With stdin a silent pipe — which is what an agent gives a subprocess — prompt libraries wait forever, and a hung provision is worse than a failed one. DevFlow decides whether it may prompt *before* building a prompt: under `--json`, `--yes`, `CI`, or a non-TTY stdin/stdout it fails immediately with `INPUT_REQUIRED`, naming the flag that would have answered the question. Every prompt has a flag.

`devflow run --json` is the one exception to one-value-on-stdout: it holds the foreground, so it prints the resolved environment and its ports as a single JSON line up front, then streams the servers' output.

## Commands

`devflow --help` groups all of these; `devflow <command> --help` documents one.

| Command | What it does | `--json` |
|---|---|:---:|
| `init [path]` | Onboarding: prerequisites, detection, registration. `-y` accepts everything detected | ✅ |
| `doctor` | Check tools, state database, projects, orphaned containers | ✅ |
| `setup-agents` | Install the skill into the agents here. `--status` `--dry-run` `--uninstall` `--all` `--only <ids>` `--scope user\|project` `-y` | ✅ |
| `skill` | Print the DevFlow agent skill (SKILL.md) | ✅ |
| `create <project> <branch>` | Branch, worktree, ports, database, deps. `--apps` `--seed` `--skip-install` | ✅ |
| `provision [path]` | Adopt an existing checkout. `--lite` `--apps` `--seed` `--base` `--skip-install` | ✅ |
| `run [env]` | Dev servers in the foreground; promotes LITE first. `--apps` | ✅ |
| `list` (`ls`) | Every environment: status, kind, ports, worktree. `-p <project>` | ✅ |
| `start [env]` / `stop [env]` | Database container up / down | ✅ |
| `teardown [path]` | Release database and ports, keep the checkout. `--name` `--quiet` | ✅ |
| `destroy <env>` | Everything, worktree included. `-y` | ✅ |
| `env-files [env]` | Regenerate `.env` files. `--all` | ✅ |
| `db [env]` | lazysql on its Postgres. `--url` prints the connection string | ✅ |
| `studio <env>` | Prisma Studio against its database. `-p <port>` | — |
| `activate [env]` | Point the port proxies at an environment. `--none` `--cwd` `--quiet` | ✅ |
| `proxy` | Daemon forwarding the original app ports to the active environment | — |
| `project add\|list\|get\|set\|inspect\|linear\|issues\|remove` | Register and configure projects | ✅ |
| `config get\|set` | DevFlow's global settings | ✅ (`get`) |
| `kill-zombies` | Kill orphaned next/turbo/tsx/vite processes. `--dry-run` | ✅ |
| `herdr sync` | Open a herdr workspace per project and environment | — |
| `completion <shell>` | Completion script for bash, zsh or fish | — |

`project set` writes every field, so a CLI-only setup is never missing anything: `--apps`, `--default-apps`, `--app-ports web:3000,api:3005`, `--dev-commands`, `--default-base-branch`, `--db-env-var-name`, `--db-docker-image`, `--default-seed`, `--source-database-url` and the Linear fields. `--app-ports` is the one that matters most — the proxy and the `.env` port rewriting both depend on it. `devflow init` and `project add` fill it in from your `dev` scripts, `.env.example` and `docker-compose.yml`; `project inspect --apply` re-detects it later.

Global settings (`config set <field> <value>`): `worktreeLocation`, `portRangeStart`, `portRangeSize`, `dbDefaultPort`, `dbSeedStrategy`, `dockerNetwork`, `dockerVolumePrefix`.

## How it works

**Worktree adoption.** `create` cuts the branch and adds the worktree under `worktreeLocation` (`.devflow/worktrees` by default). `provision` skips that and adopts a worktree you already made — the two share every later step.

**Port allocation.** Each app in the project gets one port from a configurable range (`portRangeStart` 3000, `portRangeSize` 100), recorded per environment so two of them never draw the same number.

**`.env` generation.** Every `.env` in the main checkout is copied into the worktree with the database variable pointed at this environment's Postgres, `PORT=` set to this app's allocated port, and every `http://localhost:<original>` or `http://127.0.0.1:<original>` rewritten to the allocated one. `devflow run` regenerates them before starting, because agents copy `.env` files around.

**Seeding.** `COPY_MAIN` dumps your source database (`--source-database-url`) and restores it; `FRESH_MIGRATE` runs your Prisma migrations and seed; `SNAPSHOT` restores a named dump. `pg_dump` and `psql` run inside Docker at the source server's own major version, so host client versions never mismatch. A project with neither a source database nor a Prisma schema gets an empty database, which is often exactly right.

**LITE → FULL promotion.** `run` and `db` call the same provisioning steps a full `provision` does, minus the worktree, and show the same checklist — so the wait is legible and `pnpm install` is visibly the reason for it.

**State.** One SQLite file: `$DEVFLOW_HOME/devflow.db`, else `$XDG_DATA_HOME/devflow/devflow.db`, else `~/.devflow/devflow.db`. It is created and migrated on the first command that touches it; there is no setup step. Your projects' own data never goes there — that lives in the Postgres containers.

**The proxy.** Environments run on their own ports, which is what lets them coexist. When you need your project's *original* ports (say 3000 and 3005) to reach one particular environment — an OAuth callback, a webhook, muscle memory — run `devflow proxy` as a daemon and aim it with `devflow activate [env]` (`--none` to forward nowhere).

## Linear (optional)

```bash
devflow project linear myapp --team ENG   # or omit --team to pick from a list
devflow project issues myapp              # PROJ-123  Fix the thing  leo/proj-123-fix-the-thing
devflow create myapp leo/proj-123-fix-the-thing
```

Branch names come from Linear, so the environment's branch links itself back to the issue. `--api-key`, `--team` and `--project` make the connection scriptable; without them it prompts. `project set` also takes `--linear-exclude-states` and `--linear-filter-labels` to narrow what `issues` shows.

## herdr (optional)

DevFlow works standalone. If you use [herdr](https://herdr.dev), a terminal multiplexer that owns git worktrees:

```bash
herdr plugin link "$(npm root -g)/@iziatask/devflow/herdr-plugin.toml"
devflow herdr sync
```

That gives you a workspace per project, DevFlow status and ports as sidebar tokens, new worktrees registered LITE automatically, environments stopped when a workspace closes and started when it reopens, `teardown` before a worktree is removed, and popup pickers for Linear issues. With the plugin linked, `activate` follows the workspace you focus.

## Requirements

- **Node.js 20+**, **git**
- **Docker** — for environment databases. LITE environments work without it.
- **pnpm** — required for FULL environments. DevFlow installs worktree dependencies and starts dev servers by shelling out to `pnpm`, so npm, yarn and bun projects cannot be fully provisioned yet. `--skip-install` skips the install, but the dev servers still need it.
- Optional: `lazysql` for `devflow db` (`--url` works without it), `gh`, `psql` for querying an environment's database by hand, [herdr](https://herdr.dev).

`devflow doctor` reports which of these are missing.

**Known limitations.** This is v0.x; the command surface may still move. It is developed and tested on **macOS** — Linux very likely works, Windows is not supported. Detection is best on turborepo-style monorepos (`apps/*/package.json`, `.env.example`, `docker-compose.yml`); other layouts register fine, you just fill more in with `project set`. Port rewriting in `.env` files covers `PORT=` and `localhost:<port>` URLs — a bare `WEB_PORT=3000` is left alone.

## Contributing

```bash
git clone https://github.com/leoleducq/devflow.git && cd devflow
npm install           # runs prisma generate
npm run build         # prisma generate + tsup -> dist/
npm run check-types
node bin/devflow.js --help
```

`run`, `provision`, `create` and `start` do real things — containers, ports, `pnpm install` — so point `DEVFLOW_HOME` at a scratch path while developing (`DEVFLOW_HOME=/tmp/scratch node bin/devflow.js list`), and test `setup-agents` with `--dry-run` or a fake `HOME`. See [AGENTS.md](AGENTS.md) for the layout and conventions.

The Prisma client is generated at install time rather than shipped: the query engine is a platform-specific binary. That is why `prisma` is a runtime dependency, `prisma/schema.prisma` and `prisma/migrations/` are inside the package, and there is a `postinstall`.

Issues and pull requests: [github.com/leoleducq/devflow](https://github.com/leoleducq/devflow).

## License

MIT
