import { join } from "node:path";
import fs from "fs-extra";

/**
 * The package managers DevFlow knows how to drive.
 *
 * A worktree's dependencies have to be installed, its dev servers started and
 * its Prisma binary executed. Every one of those is a different argv per
 * manager, and getting one wrong is a provisioning that fails halfway. This
 * module is the only place in DevFlow that knows those argvs.
 */
export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** npm is the one manager that ships with Node, so it is the safe default. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = "npm";

export const isPackageManager = (value: string): value is PackageManager =>
  (PACKAGE_MANAGERS as readonly string[]).includes(value);

/** Where the install page for each manager lives, for error messages. */
const INSTALL_URL: Record<PackageManager, string> = {
  pnpm: "https://pnpm.io/installation",
  npm: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
  yarn: "https://yarnpkg.com/getting-started/install",
  bun: "https://bun.sh/docs/installation",
};

export const installUrl = (manager: PackageManager): string =>
  INSTALL_URL[manager];

/** Lock file at a project root -> the manager that wrote it. */
const LOCK_FILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

/**
 * The manager named by corepack's `packageManager` field, e.g. `"pnpm@9.0.0"`.
 *
 * Returns null for a field that is absent, malformed, or names something
 * DevFlow cannot drive — all of which mean "keep looking", not "fail".
 */
function fromPackageManagerField(pkg: unknown): PackageManager | null {
  const field = (pkg as { packageManager?: unknown } | null)?.packageManager;
  if (typeof field !== "string") return null;
  const name = field.trim().split("@")[0]?.trim().toLowerCase() ?? "";
  return isPackageManager(name) ? name : null;
}

/**
 * Which manager a project uses, in order of authority:
 *
 *  1. the `packageManager` field in its root package.json — the corepack
 *     standard, and the only signal the repo states on purpose;
 *  2. the lock file at its root — what was actually used last;
 *  3. npm, which every Node install already has.
 *
 * Falling back rather than failing matters: a repo with neither signal still
 * has to be provisionable.
 */
export async function detectPackageManager(
  projectPath: string,
): Promise<PackageManager> {
  const pkg = await fs
    .readJSON(join(projectPath, "package.json"))
    .catch(() => null);
  const declared = fromPackageManagerField(pkg);
  if (declared) return declared;

  for (const [file, manager] of LOCK_FILES) {
    if (await fs.pathExists(join(projectPath, file))) return manager;
  }

  return DEFAULT_PACKAGE_MANAGER;
}

/**
 * The manager to use for a worktree, honouring an explicit choice.
 *
 * `stored` is the project's `packageManager` column: set means the user (or
 * `project add`) pinned it, null means "work it out from the checkout".
 */
export async function resolvePackageManager(
  worktreePath: string,
  stored?: string | null,
): Promise<PackageManager> {
  if (stored && isPackageManager(stored)) return stored;
  return detectPackageManager(worktreePath);
}

/** One command to run: the binary and its arguments, ready for execa. */
export type Argv = { command: string; args: string[] };

/**
 * `<manager> install`. Identical shape everywhere, but spelled out so callers
 * never have to hardcode a manager name.
 */
export function installArgv(manager: PackageManager): Argv {
  return { command: manager, args: ["install"] };
}

/**
 * Run a script declared in package.json.
 *
 * yarn is the odd one out: `yarn run <script>` works in both classic and
 * berry, and is unambiguous, so it is what we use rather than the bare
 * `yarn <script>` shorthand.
 */
export function runScriptArgv(
  manager: PackageManager,
  script: string,
  args: string[] = [],
): Argv {
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["run", script, ...args] };
    case "npm":
      // npm swallows everything after the script name unless it is fenced off.
      return {
        command: "npm",
        args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])],
      };
    case "yarn":
      return { command: "yarn", args: ["run", script, ...args] };
    case "bun":
      return { command: "bun", args: ["run", script, ...args] };
  }
}

/**
 * Execute a binary resolved from the project's dependencies — `prisma`,
 * `next`, `turbo`. This is emphatically not "download and run a package":
 * DevFlow always wants the version the worktree installed.
 *
 *  - pnpm: `pnpm exec <bin>`
 *  - npm:  `npm exec -- <bin>` — the `--` is what stops npm from reading the
 *          binary's own flags as its own
 *  - yarn: `yarn exec <bin> -- <args>` — present in berry, and undocumented
 *          but working in classic 1.22. The `--` is not optional: classic
 *          silently swallows every `--flag` after the binary without it
 *          (`yarn exec turbo run build --filter=x` reaches turbo as
 *          `run build`), while berry ignores the fence. `yarn dlx` is
 *          deliberately avoided — it fetches from the registry instead of
 *          using the dependency the worktree installed.
 *  - bun:  `bunx <bin>`, which prefers a locally installed binary
 */
export function execBinaryArgv(
  manager: PackageManager,
  binary: string,
  args: string[] = [],
): Argv {
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["exec", binary, ...args] };
    case "npm":
      return { command: "npm", args: ["exec", "--", binary, ...args] };
    case "yarn":
      return {
        command: "yarn",
        args: ["exec", binary, ...(args.length > 0 ? ["--", ...args] : [])],
      };
    case "bun":
      return { command: "bunx", args: [binary, ...args] };
  }
}

/**
 * Run a script in one workspace package of a monorepo.
 *
 * The four managers disagree about almost everything here:
 *
 *  - pnpm: `pnpm --filter <pkg> run <script>`
 *  - npm:  `npm run <script> -w <pkg>` (npm 7+); the workspace selector comes
 *          after the script, not before
 *  - yarn: `yarn workspace <pkg> run <script>` — same spelling in classic and
 *          berry, unlike `workspaces foreach`, which is berry-only
 *  - bun:  `bun run --filter <pkg> <script>`
 */
export function workspaceScriptArgv(
  manager: PackageManager,
  workspacePackage: string,
  script: string,
  args: string[] = [],
): Argv {
  switch (manager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: ["--filter", workspacePackage, "run", script, ...args],
      };
    case "npm":
      return {
        command: "npm",
        args: [
          "run",
          script,
          "-w",
          workspacePackage,
          ...(args.length > 0 ? ["--", ...args] : []),
        ],
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["workspace", workspacePackage, "run", script, ...args],
      };
    case "bun":
      return {
        command: "bun",
        args: ["run", "--filter", workspacePackage, script, ...args],
      };
  }
}

/**
 * What DevFlow tells the user when the manager a project needs is not there.
 * Naming the manager the project actually uses is the whole point: telling
 * someone with a bun repo to install pnpm is worse than saying nothing.
 */
export function missingManagerMessage(
  manager: PackageManager,
  context: string,
): string {
  return (
    `${manager} is not on PATH. DevFlow ${context} with ${manager} ` +
    `(this project's package manager); install it (${installUrl(manager)}), ` +
    `pin a different one with \`devflow project set <project> --package-manager <pm>\`, ` +
    `or provision with --skip-install and install them yourself.`
  );
}
