# DevFlow

**Runnable environments for git worktrees.**

Your branch has a worktree. It does not have a database, free ports, `.env`
files that point anywhere useful, or a dev server. DevFlow gives it all four —
one isolated environment per branch, several at a time, without them colliding.

```bash
npm install -g @iziatask/devflow
cd ~/code/myapp
devflow init          # detect the project, register it
devflow provision     # give this checkout ports, a database, .env files
devflow run           # dev servers, in the foreground
```

## Install

```bash
npm install -g @iziatask/devflow     # the usual way; gives you the `devflow` binary
npx @iziatask/devflow doctor         # try it without installing
npm install -g github:leoleducq/devflow   # straight from git
```

Installing runs `prisma generate`, which builds the query engine for your
platform — so the install needs network access the first time. Check the result
with `devflow doctor`.

## Why

A branch gets a worktree in a second. What it does not get is a database of its
own, free ports, `.env` files that point at those ports, or a running dev
server. So a second branch collides with the first: same port, same database,
same `.env`.

DevFlow gives each worktree its own. **An environment is a git worktree that
DevFlow has provisioned** — a Postgres container, allocated ports, generated
`.env` files and dev servers, isolated from every other branch. Run five
branches at once and nothing overlaps.

## LITE by default

Creating a worktree costs nothing. Provisioning one costs minutes and a
gigabyte of RAM. So DevFlow separates them:

| | LITE | FULL |
|---|---|---|
| Registered in DevFlow | yes | yes |
| `.env` files | copied from the main checkout | generated for this environment |
| Allocated ports | — | one per app |
| Postgres container | — | started and seeded |
| Dependencies installed | optional | yes |

A new worktree is registered **LITE** in about a second. It is promoted to
**FULL** by the first `devflow run` or `devflow db`, so opening ten branches to
read code does not start ten Postgres containers.

## What an environment gets

- **A Postgres container of its own**, seeded from your main database
  (`COPY_MAIN`, needs `--source-database-url`), from your Prisma migrations
  (`FRESH_MIGRATE`), or from a dump (`SNAPSHOT`). A project with neither a
  source database nor a Prisma schema gets an empty database, which is often
  exactly right.
- **Allocated ports**, one per app, out of a configurable range.
- **Generated `.env` files**: every `.env` in the main checkout is copied with
  the database URL swapped and every `localhost:<original port>` rewritten to
  this environment's port — so `NEXT_PUBLIC_API_URL`, CORS lists and callbacks
  all point at the right place.
- **Dev servers**, run in the foreground with their output interleaved, so one
  terminal shows every app and `Ctrl+C` stops them all.

## Commands

### Setup

```bash
devflow init [path]              # onboarding: prerequisites, detection, registration
devflow doctor                   # check tools, database, projects, orphaned containers
```

### Environments

```bash
devflow provision [path] [--lite]  # register or fully provision a checkout
devflow run [--apps web,api]       # dev servers in the foreground (promotes LITE first)
devflow list [--json]              # every environment: status, kind, ports, worktree
devflow start|stop <env>           # database container up / down
devflow teardown [path]            # release database and ports, keep the checkout
devflow destroy <env> --yes        # everything, worktree included
devflow env-files [env] [--all]    # regenerate .env files for an environment
devflow db [--url]                 # lazysql on its Postgres, or print the URL
devflow studio <env>               # Prisma Studio against its database
devflow kill-zombies [--dry-run]   # orphaned next/turbo/tsx/vite processes
```

`devflow provision` adopts a worktree you already made (`git worktree add …`),
and `--lite` registers it without provisioning anything.
`devflow create <project> <branch>` does the whole thing at once: it cuts the
branch, creates the worktree and provisions it FULL.

### Projects

```bash
devflow project list [--json]
devflow project get <name>                  # every setting, readable
devflow project set <name> --<flag> <val>   # change any of them (see the table below)
devflow project inspect <name> [--apply]    # re-detect apps, ports, dev commands
devflow project linear <name>               # connect Linear, pick the team from a list
devflow project issues <name> [--json]      # open issues, with their branch names
devflow project remove <name>
```

`devflow project set` writes every field, so a CLI-only setup is not missing
anything:

| Flag | What it does |
|---|---|
| `--name`, `--path` | rename, or point at a moved checkout |
| `--apps`, `--default-apps` | which apps exist, which ones `run` starts |
| `--default-base-branch` | branch new environments are cut from (default `main`) |
| `--app-ports web:3000,api:3005` | the ports each app uses in the main checkout |
| `--dev-commands "web=next dev,api=tsx watch src"` | how to start each app |
| `--db-env-var-name`, `--db-docker-image` | database wiring |
| `--default-seed`, `--source-database-url` | how new databases are seeded |
| `--linear-api-key`, `--linear-team-id`, `--linear-project-id` | Linear connection |
| `--linear-exclude-states`, `--linear-filter-labels` | which issues to show |

`--app-ports` is the one that matters most: the proxy and the `.env` port
rewriting both depend on it. `devflow init` and `devflow project add` fill it in
automatically from your `dev` scripts, `.env.example` and `docker-compose.yml`.

### Global settings

```bash
devflow config get [field]
devflow config set <field> <value>
```

`worktreeLocation`, `portRangeStart`, `portRangeSize`, `dbDefaultPort`,
`dbSeedStrategy`, `dockerNetwork`, `dockerVolumePrefix`.

### The proxy

Each environment runs on its own ports, which is what makes several of them
coexist. When you want your project's *original* ports (say `3000` and `3005`)
to reach one particular environment — for an OAuth callback, a webhook, or
muscle memory — run the proxy as a daemon and point it wherever you are
working:

```bash
devflow proxy &                # long-running; forwards original ports
devflow activate [env]         # choose which environment they reach
devflow activate --none        # forward nowhere
```

`devflow activate` with no argument targets the environment of the current
checkout.

## Linear

```bash
devflow project linear myapp     # asks for an API key, lists your teams, saves the choice
devflow project issues myapp     # PROJ-123  Fix the thing  leo/proj-123-fix-the-thing
```

The branch names come from Linear, so `devflow create myapp <that branch>` gets
you an environment whose branch Linear will link to the issue by itself.

## herdr integration (optional)

DevFlow works on its own; this section is only for users of
[herdr](https://herdr.dev), a terminal multiplexer that owns git worktrees.

```bash
herdr plugin link $(npm root -g)/devflow-cli/herdr-plugin.toml
devflow herdr sync
```

That gives you: a workspace per project, DevFlow status and ports as sidebar
tokens, new worktrees provisioned LITE automatically, environments stopped when
a workspace closes and started when it reopens, `devflow teardown` before a
worktree is removed, plus popup pickers for Linear issues and for destroying
environments. With the plugin linked, `devflow activate` follows the workspace
you focus.

## The agent skill

`devflow skill` prints a SKILL.md describing DevFlow to a coding agent. Install
it where your agent reads skills:

```bash
mkdir -p ~/.claude/skills/devflow && devflow skill > ~/.claude/skills/devflow/SKILL.md
```

`devflow herdr sync` does this for `~/.claude/skills/`, `~/.pi/agent/skills/`
and `~/.codex/skills/`, for whichever of those exist.

## Where DevFlow keeps its state

One SQLite file:

1. `$DEVFLOW_HOME/devflow.db` if `DEVFLOW_HOME` is set,
2. else `$XDG_DATA_HOME/devflow/devflow.db` if `XDG_DATA_HOME` is set,
3. else `~/.devflow/devflow.db`.

It is created and migrated on the first command that touches it — there is no
setup step. Your projects' own data never goes in here; that lives in the
Postgres containers, one per environment.

## Requirements

- Node.js 20+
- git
- Docker, for environment databases (LITE environments work without it)
- pnpm — DevFlow installs worktree dependencies and starts dev servers with it,
  so a FULL environment needs it on PATH. `--skip-install` lets you install
  them yourself, but the dev servers still shell out to `pnpm`.
- optional: [herdr](https://herdr.dev), `lazysql` for `devflow db` (`--url`
  works without it), `gh` to create an environment from a pull request, `psql`
  to query an environment's database by hand

`devflow doctor` tells you which of these are missing.

## Project shapes

DevFlow detects turborepo-style monorepos best: it reads `apps/*/package.json`
for dev scripts and ports, `.env.example` for the database variable, and
`docker-compose.yml` for the Postgres image. Other layouts register fine — the
detection just finds less, and you fill the rest in with `devflow project set`.

## Development

```bash
npm install       # runs prisma generate
npm run build     # prisma generate + tsup
npm run dev -- --help
npm run check-types
```

The Prisma client is **generated at install time**, not shipped: the query
engine is a platform-specific binary, so a package containing one would only
work on the machine that built it. `prisma` is therefore a runtime dependency,
`prisma/schema.prisma` and `prisma/migrations/` ship inside the package, and a
`postinstall` script generates the client for whatever platform you installed
on. Migrations are applied by the CLI itself on first run, statement by
statement, recorded in `_prisma_migrations` in Prisma's own format — so
`prisma migrate deploy` against the same file later agrees about what has run.

## License

MIT
