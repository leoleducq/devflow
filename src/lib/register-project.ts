import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import { TemplateService } from "../services/index.js";
import type { ProjectInspection } from "../services/index.js";
import { prisma } from "../db/index.js";
import type { Project } from "../db/types.js";

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

const expand = (input: string): string =>
  resolve(input.startsWith("~") ? input.replace("~", homedir()) : input);

/**
 * Read a directory and work out what kind of project it is. Fails only when
 * the directory could not be a project at all; a shallow result is still
 * useful, because every field is editable afterwards.
 */
export async function inspectForRegistration(
  pathArg: string,
): Promise<Registration> {
  const projectPath = expand(pathArg);

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
      inspectionError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Print what was detected, so the user can see it before confirming. */
export function printRegistration(registration: Registration): void {
  const line = (label: string, value: string) =>
    console.log(`  ${chalk.bold(label.padEnd(14))} ${value || chalk.dim("-")}`);

  console.log();
  console.log(chalk.bold.underline("Detected"));
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
  line("dbEnvVarName", registration.dbEnvVarName ?? "");
  line("dbDockerImage", registration.dbDockerImage ?? "");
  console.log();

  if (registration.inspectionError) {
    console.log(
      chalk.yellow(`Could not inspect deeply: ${registration.inspectionError}`),
    );
    console.log(
      chalk.dim("Fill the rest in with `devflow project set <name> --<field> <value>`."),
    );
    console.log();
  }
}

/**
 * Create the Project row. Interactive by default: the detected values become
 * the defaults of a short form, so confirming is one Enter per field and
 * correcting anything is possible without a second command.
 */
export async function registerProject(
  registration: Registration,
  options: { interactive: boolean },
): Promise<Project> {
  printRegistration(registration);

  const detectedName = registration.name ?? basename(registration.path);
  const detectedDefaultApps = registration.apps.filter(app => app !== "docs");

  let name = detectedName;
  let apps = registration.apps;
  let defaultApps = detectedDefaultApps;
  let dbEnvVarName = registration.dbEnvVarName ?? "DATABASE_URL";
  let dbDockerImage = registration.dbDockerImage ?? "postgres:15-alpine";
  let sourceDatabaseUrl: string | null = null;
  let defaultBaseBranch = await detectDefaultBranch(registration.path);

  if (options.interactive) {
    const answers = await inquirer.prompt<{
      name: string;
      apps: string;
      defaultApps: string;
      defaultBaseBranch: string;
      dbEnvVarName: string;
      dbDockerImage: string;
      sourceDatabaseUrl: string;
    }>([
      { type: "input", name: "name", message: "Project name:", default: detectedName },
      {
        type: "input",
        name: "apps",
        message: "Apps (comma-separated):",
        default: registration.apps.join(","),
      },
      {
        type: "input",
        name: "defaultApps",
        message: "Apps `devflow run` starts by default:",
        default: detectedDefaultApps.join(","),
      },
      {
        type: "input",
        name: "defaultBaseBranch",
        message: "Base branch new environments are cut from:",
        default: defaultBaseBranch,
      },
      {
        type: "input",
        name: "dbEnvVarName",
        message: "Env var holding the database URL:",
        default: dbEnvVarName,
      },
      {
        type: "input",
        name: "dbDockerImage",
        message: "Postgres image for environment databases:",
        default: dbDockerImage,
      },
      {
        type: "input",
        name: "sourceDatabaseUrl",
        message: "Database to copy data from (blank for none):",
        default: "",
      },
    ]);

    name = answers.name.trim() || detectedName;
    apps = splitList(answers.apps);
    defaultApps = splitList(answers.defaultApps);
    defaultBaseBranch = answers.defaultBaseBranch.trim() || defaultBaseBranch;
    dbEnvVarName = answers.dbEnvVarName.trim() || dbEnvVarName;
    dbDockerImage = answers.dbDockerImage.trim() || dbDockerImage;
    sourceDatabaseUrl = answers.sourceDatabaseUrl.trim() || null;
  }

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
