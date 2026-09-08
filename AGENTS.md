# AGENTS.md

Instructions for coding agents working **on DevFlow itself**.

If you are trying to *use* DevFlow to run a project, this is the wrong file:
run `devflow skill` instead, or read `skills/devflow/SKILL.md`.

## What this is

A TypeScript CLI (`devflow`, published as `@iziatask/devflow`) that gives a git
worktree a runnable environment: a Postgres container, allocated ports,
generated `.env` files, dependencies and dev servers. Its own state is a
SQLite file at `~/.devflow/devflow.db`, managed with Prisma.

## Layout

```
src/index.ts        commander program; every command is registered here
src/commands/       one file per CLI command, argument parsing and output only
src/services/       the actual work: environments, docker, ports, env files, herdr
src/lib/            helpers shared by commands (json output, errors, version)
src/db/             the Prisma client, its path resolution and bootstrap
prisma/schema.prisma  DevFlow's own state, not the projects' data
skills/devflow/SKILL.md  the agent skill `setup-agents` installs
```

Commands stay thin: they parse flags, call one service, and print. Logic that
outlives a single command belongs in `src/services/`.

## Build and check

```bash
npm run build        # prisma generate + tsup -> dist/index.js
npm run check-types  # tsc --noEmit
node bin/devflow.js --help
```

There is no test suite yet. Verify changes by running the CLI against a
scratch state directory (see Safety below).

## Safety rules

**`run`, `provision`, `create` and `start` do real things.** They start Docker
containers, allocate ports, run `pnpm install` in a worktree and spawn dev
servers. They are not dry by default and they are slow. Do not run them to
"check something compiles".

**Never touch the real state directory while developing.** Point
`DEVFLOW_HOME` at a scratch path and DevFlow will use a throwaway SQLite file:

```bash
DEVFLOW_HOME=/tmp/devflow-scratch node bin/devflow.js list --json
```

**Never install skills into the real agent directories while testing.**
`setup-agents` writes to `$HOME`. Use `--dry-run`, or a fake home:

```bash
HOME=/tmp/fake-home node bin/devflow.js setup-agents --dry-run
```

**`destroy` deletes a worktree and its database.** `teardown` and `stop` are
the reversible operations; prefer them.

## Conventions

- Every command that returns data takes `--json`: one JSON value on stdout,
  nothing else — no spinner, no progress. Use the helpers in
  `src/lib/json-output.ts` (`printJson`, `failCommand`, `startSpinner`,
  `redact`) rather than calling `console.log(JSON.stringify(...))`.
- **Never prompt without going through `src/lib/interactive.ts`.** No prompt
  library fails safely when stdin is a silent pipe, which is what a coding
  agent gives you — they wait forever. `canPrompt()` decides, `askFor()` reads
  a flag before asking, and both fail with `INPUT_REQUIRED` naming the flag
  that would have answered the question. Any new prompt needs a flag too.
- Colour goes through `src/lib/colors.ts` (picocolors), never a direct import:
  NO_COLOR and non-TTY are handled there, once.
- Multi-step work uses `runSteps` from `src/lib/task-list.ts` rather than a
  spinner whose text mutates, so each step keeps its own state and timing.
  Tables use `src/lib/table.ts`, which measures width ignoring colour codes.
- Failures raised deliberately use `DevflowError` with a code from
  `src/lib/errors.ts`, so JSON callers can branch on the cause.
- Secrets (`linearApiKey`, database passwords) are masked by `redact` before
  anything reaches `--json` output. Keep it that way when adding fields.
- Comments explain *why*, not what. The codebase leans on this heavily.
- The version lives only in `package.json`; read it with `version()` from
  `src/lib/version.ts`.

## Changing the skill

`skills/devflow/SKILL.md` is the file every coding agent reads. If you add,
rename or remove a command or flag, update it in the same change — a skill
that documents a flag the CLI does not have is worse than no skill. It is
shipped in the npm package (`files` in `package.json`) and installed by
`devflow setup-agents`.

## Commits

Small, one logical change each. No AI or tooling attribution in the message.
