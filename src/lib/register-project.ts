import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { colors } from "./colors.js";
import fs from "fs-extra";
import * as prompts from "./interactive.js";
import { TemplateService } from "../services/index.js";
import type { ProjectInspection } from "../services/index.js";
import { prisma } from "../db/index.js";
import type { Project } from "../db/types.js";
import {
  detectPackageManager,
  isPackageManager,
  PACKAGE_MANAGERS,
} from "./package-manager.js";

/**
 * What DevFlow found in a directory, ready to be turned into a Project row.
 *
 * A plain (non-turborepo) project still gets registered: `inspectProject`
 * refuses it, so the fields it would have derived are simply left empty and
 * the user fills them in with `devflow project set`.
 */
export type Registration = ProjectInspection & {
  /** Why the automatic inspection could not run, when it could not. */
  inspectionError: string | null;
};

/** `~/code/app` and `./app` both become an absolute path. */
export const expandProjectPath = (input: string): string =>
  resolve(input.startsWith("~") ? input.replace("~", homedir()) : input);

/**
 * Read a directory and work out what kind of project it is. Fails only when
 * the directory could not be a project at all; a shallow result is still
 * useful, because every field is editable afterwards.
 */
export async function inspectForRegistration(
  pathArg: string,
): Promise<Registration> {
  const projectPath = expandProjectPath(pathArg);

  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`${projectPath} does not exist`);
  }
  if (!(await fs.pathExists(`${projectPath}/.git`))) {
    throw new Error(
      `${projectPath} is not a git repository. DevFlow provisions git worktrees, so it needs one.`,
    );
  }
  if (!(await fs.pathExists(`${projectPath}/package.json`))) {
    throw new Error(`${projectPath} has no package.json`);
  }

  const templates = new TemplateService();
  try {
    return { ...(await templates.inspectProject(projectPath)), inspectionError: null };
  } catch (error) {
    // Not a turborepo, most likely. Fall back to the little we can be sure of.
    const pkg = await fs.readJSON(`${projectPath}/package.json`).catch(() => null);
    return {
      path: projectPath,
      name: typeof pkg?.name === "string" ? pkg.name : null,
      type: "STANDARD",
      apps: [],
      devCommands: {},
      appPorts: {},
      dbEnvVarName: null,
      dbDockerImage: null,
      packageManager: await detectPackageManager(projectPath),
      inspectionError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Print what was detected, so the user can see it before confirming. */
export function printRegistration(registration: Registration): void {
  const line = (label: string, value: string) =>
    console.log(`  ${colors.bold(label.padEnd(14))} ${value || colors.dim("-")}`);

  console.log();
  console.log(colors.bold.underline("Detected"));
  line("path", registration.path);
  line("name", registration.name ?? basename(registration.path));
  line("type", registration.type);
  line("apps", registration.apps.join(", "));
  line(
    "appPorts",
    Object.entries(registration.appPorts)
      .map(([app, port]) => `${app}:${port}`)
      .join(", "),
  );
  line(
    "devCommands",
    Object.entries(registration.devCommands)
      .map(([app, cmd]) => `${app}=${cmd}`)
      .join(", "),
  );
  line("packageManager", registration.packageManager);
  line("dbEnvVarName", registration.dbEnvVarName ?? "");
  line("dbDockerImage", registration.dbDockerImage ?? "");
  console.log();

  if (registration.inspectionError) {
    console.log(
      colors.yellow(`Could not inspect deeply: ${registration.inspectionError}`),
    );
    console.log(
      colors.dim("Fill the rest in with `devflow project set <name> --<field> <value>`."),
    );
    console.log();
  }
}

/**
 * Every answer the registration wizard needs, as flags.
 *
 * Each question below has one, so `devflow init` and `devflow project add`
 * can be driven end to end without a terminal. A prompt with no flag behind
 * it is a prompt an agent cannot get past, which is the whole failure mode
 * this shape exists to prevent.
 */
export type RegistrationAnswers = {
  name?: string;
  apps?: string;
  defaultApps?: string;
  defaultBaseBranch?: string;
  packageManager?: string;
  dbEnvVarName?: string;
  dbDockerImage?: string;
  sourceDatabaseUrl?: string;
};

/**
 * The flags that answer the wizard's questions, declared once and attached to
 * both `devflow init` and `devflow project add`.
 *
 * They exist so neither command has a question that can only be answered by a
 * human at a terminal: an agent passes the flags it cares about and lets the
 * detected values stand for the rest.
 */
export const REGISTRATION_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["--name <name>", "Project name (default: the detected one)"],
  ["--apps <a,b>", "Every app the repo contains"],
  ["--default-apps <a,b>", "Apps `devflow run` starts when none are named"],
  ["--default-base-branch <branch>", "Branch new environments are cut from"],
  [
    "--package-manager <pm>",
    `Package manager to install and run with: ${PACKAGE_MANAGERS.join(" | ")}`,
  ],
  ["--db-env-var-name <VAR>", "Env var holding the database URL"],
  ["--db-docker-image <image>", "Postgres image for environment databases"],
  ["--source-database-url <url>", "Database COPY_MAIN dumps from"],
];

/** Pick the registration answers out of whatever commander collected. */
export const registrationAnswers = (
  options: Record<string, unknown>,
): RegistrationAnswers => {
  const read = (key: string): string | undefined =>
    typeof options[key] === "string" ? (options[key] as string) : undefined;
  return {
    name: read("name"),
    apps: read("apps"),
    defaultApps: read("defaultApps"),
    defaultBaseBranch: read("defaultBaseBranch"),
    packageManager: read("packageManager"),
    dbEnvVarName: read("dbEnvVarName"),
    dbDockerImage: read("dbDockerImage"),
    sourceDatabaseUrl: read("sourceDatabaseUrl"),
  };
};

/**
 * Create the Project row.
 *
 * Interactive on a terminal: the detected values become the defaults of a
 * short form, so confirming is one Enter per field. Everywhere else — a pipe,
 * CI, `--yes`, `--json` — the detected values are used as they are, and any
 * flag the caller passed overrides them. Nothing here can block waiting for
 * input that will never come.
 */
export async function registerProject(
  registration: Registration,
  options: {
    interactive: boolean;
    answers?: RegistrationAnswers;
    json?: boolean;
  },
): Promise<Project> {
  const answers = options.answers ?? {};
  if (!options.json) printRegistration(registration);

  const detectedName = registration.name ?? basename(registration.path);
  const detectedDefaultApps = registration.apps.filter(app => app !== "docs");
  const detectedBaseBranch = await detectDefaultBranch(registration.path);

  // A flag always wins; a prompt only happens when the caller asked for one
  // and this run can actually hold a conversation.
  const interactive =
    options.interactive && prompts.canPrompt({ json: options.json });

  const field = async (
    provided: string | undefined,
    message: string,
    fallback: string,
  ): Promise<string> => {
    if (provided !== undefined) return provided.trim() || fallback;
    if (!interactive) return fallback;
    const answer = await prompts.text({ message, initialValue: fallback });
    return answer.trim() || fallback;
  };

  const name = await field(answers.name, "Project name", detectedName);
  const apps = splitList(
    await field(answers.apps, "Apps (comma-separated)", registration.apps.join(",")),
  );
  const defaultApps = splitList(
    await field(
      answers.defaultApps,
      "Apps `devflow run` starts by default",
      detectedDefaultApps.join(","),
    ),
  );
  const defaultBaseBranch = await field(
    answers.defaultBaseBranch,
    "Base branch new environments are cut from",
    detectedBaseBranch,
  );
  const packageManager = await field(
    answers.packageManager,
    `Package manager (${PACKAGE_MANAGERS.join(" | ")})`,
    registration.packageManager,
  );
  if (!isPackageManager(packageManager)) {
    throw new Error(
      `packageManager: expected one of ${PACKAGE_MANAGERS.join(", ")}, got '${packageManager}'`,
    );
  }

  const dbEnvVarName = await field(
    answers.dbEnvVarName,
    "Env var holding the database URL",
    registration.dbEnvVarName ?? "DATABASE_URL",
  );
  const dbDockerImage = await field(
    answers.dbDockerImage,
    "Postgres image for environment databases",
    registration.dbDockerImage ?? "postgres:15-alpine",
  );
  const sourceDatabaseUrl =
    (await field(
      answers.sourceDatabaseUrl,
      "Database to copy data from (blank for none)",
      "",
    )) || null;

  const existing = await prisma.project.findUnique({ where: { name } });
  if (existing) {
    throw new Error(
      `A project named '${name}' is already registered (${existing.path}). Rename it, or update that one with \`devflow project set\`.`,
    );
  }

  return prisma.project.create({
    data: {
      name,
      path: registration.path,
      type: registration.type,
      apps: JSON.stringify(apps),
      defaultApps: JSON.stringify(defaultApps),
      defaultBaseBranch,
      packageManager,
      dbEnvVarName,
      dbDockerImage,
      devCommands: JSON.stringify(registration.devCommands),
      appPorts: JSON.stringify(registration.appPorts),
      sourceDatabaseUrl,
    },
  });
}

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

/**
 * The repository's own default branch, so a project on `develop` or `master`
 * is not silently registered against `main`.
 */
async function detectDefaultBranch(projectPath: string): Promise<string> {
  const { execa } = await import("execa");
  try {
    const { stdout } = await execa(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: projectPath },
    );
    const branch = stdout.trim().replace(/^origin\//, "");
    if (branch) return branch;
  } catch {
    // No remote, or no HEAD ref for it.
  }

  try {
    const { stdout } = await execa("git", ["branch", "--show-current"], {
      cwd: projectPath,
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Detached head or not a repo; the caller already checked it is one.
  }

  return "main";
}
