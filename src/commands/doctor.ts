import { Command } from "commander";
import chalk from "chalk";
import { execa } from "execa";
import fs from "fs-extra";
import { prisma, databaseFile, devflowHome } from "../db/index.js";
import { checkTool, which } from "../lib/checks.js";
import type { Check, CheckLevel } from "../lib/checks.js";

const MIN_NODE_MAJOR = 20;

const SYMBOL: Record<CheckLevel, string> = {
  ok: chalk.green("✔"),
  warn: chalk.yellow("!"),
  fail: chalk.red("✘"),
};

function checkNode(): Check {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: "node", level: "ok", detail: `v${version}` };
  }
  return {
    name: "node",
    level: "fail",
    detail: `v${version}`,
    hint: `DevFlow needs Node ${MIN_NODE_MAJOR} or newer`,
  };
}

/** Docker being installed is not enough — the daemon has to answer. */
async function checkDocker(): Promise<Check> {
  if (!(await which("docker"))) {
    return {
      name: "docker",
      level: "fail",
      detail: "not found on PATH",
      hint: "Install Docker Desktop or the Docker engine; environments need it for Postgres",
    };
  }
  try {
    const { stdout } = await execa("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    return { name: "docker", level: "ok", detail: `daemon ${stdout.trim()}` };
  } catch {
    return {
      name: "docker",
      level: "fail",
      detail: "installed, daemon not responding",
      hint: "Start Docker, then run `devflow doctor` again",
    };
  }
}

async function checkDatabase(): Promise<Check[]> {
  const file = databaseFile();
  const checks: Check[] = [];

  checks.push(
    (await fs.pathExists(devflowHome()))
      ? { name: "devflow home", level: "ok", detail: devflowHome() }
      : {
          name: "devflow home",
          level: "warn",
          detail: `${devflowHome()} does not exist yet`,
          hint: "It is created the first time a command writes to the database",
        },
  );

  try {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
    );
    checks.push({
      name: "database",
      level: "ok",
      detail: `${file} (${Number(rows[0]?.count ?? 0)} migration(s) applied)`,
    });
  } catch (error) {
    checks.push({
      name: "database",
      level: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: `Delete ${file} and run any devflow command to recreate it`,
    });
  }

  return checks;
}

async function checkProjects(): Promise<Check[]> {
  const projects = await prisma.project.findMany({ orderBy: { name: "asc" } });

  if (projects.length === 0) {
    return [
      {
        name: "projects",
        level: "warn",
        detail: "none registered",
        hint: "Register one with `devflow init` in a project directory",
      },
    ];
  }

  return Promise.all(
    projects.map(async (project): Promise<Check> => {
      if (!(await fs.pathExists(project.path))) {
        return {
          name: `project ${project.name}`,
          level: "fail",
          detail: `${project.path} is gone`,
          hint: `Fix it with \`devflow project set ${project.name} --path <new path>\`, or remove it with \`devflow project remove ${project.name}\``,
        };
      }

      const missing: string[] = [];
      if (!project.appPorts) missing.push("appPorts");
      if (!project.devCommands) missing.push("devCommands");

      if (missing.length > 0) {
        return {
          name: `project ${project.name}`,
          level: "warn",
          detail: `${project.path} — no ${missing.join(", ")}`,
          hint: `The proxy and .env port rewriting need appPorts; run \`devflow project inspect ${project.name}\``,
        };
      }

      return {
        name: `project ${project.name}`,
        level: "ok",
        detail: project.path,
      };
    }),
  );
}

/**
 * Postgres containers DevFlow started that no environment claims any more —
 * usually the remains of a crashed teardown, holding a port and a volume.
 */
async function checkOrphanContainers(): Promise<Check> {
  let names: string[];
  try {
    const { stdout } = await execa("docker", [
      "ps",
      "-a",
      "--filter",
      "name=devflow-db-",
      "--format",
      "{{.Names}}",
    ]);
    names = stdout.split("\n").map(s => s.trim()).filter(Boolean);
  } catch {
    return {
      name: "containers",
      level: "warn",
      detail: "could not be listed (is Docker running?)",
    };
  }

  const known = new Set(
    (
      await prisma.environmentDatabase.findMany({
        select: { containerName: true },
      })
    ).map(db => db.containerName),
  );
  const orphans = names.filter(name => !known.has(name));

  if (orphans.length === 0) {
    return {
      name: "containers",
      level: "ok",
      detail: `${names.length} DevFlow container(s), no orphans`,
    };
  }

  return {
    name: "containers",
    level: "warn",
    detail: `${orphans.length} orphaned: ${orphans.join(", ")}`,
    hint: `Remove them with: docker rm -f ${orphans.join(" ")}`,
  };
}

export const doctorCommand = new Command()
  .name("doctor")
  .description("Check prerequisites, the database and the registered projects")
  .option("--json", "Machine-readable output")
  .action(async options => {
    const checks: Check[] = [
      checkNode(),
      await checkTool({
        command: "git",
        required: true,
        hint: "DevFlow drives git worktrees; install git",
      }),
      await checkDocker(),
      await checkTool({
        command: "pnpm",
        required: false,
        hint: "Needed to install dependencies in worktrees and run prisma in them",
      }),
      await checkTool({
        command: "herdr",
        required: false,
        versionArgs: ["--version"],
        hint: "Optional: herdr owns the worktrees DevFlow provisions",
      }),
      await checkTool({
        command: "lazysql",
        required: false,
        hint: "Optional: `devflow db` opens it; without it use `devflow db --url`",
      }),
      await checkTool({
        command: "gh",
        required: false,
        versionArgs: ["--version"],
        hint: "Optional: needed to create an environment from a pull request",
      }),
      await checkTool({
        command: "psql",
        required: false,
        hint: "Optional: handy for querying an environment's database directly",
      }),
      ...(await checkDatabase()),
      ...(await checkProjects()),
      await checkOrphanContainers(),
    ];

    await prisma.$disconnect();

    if (options.json) {
      console.log(JSON.stringify(checks, null, 2));
    } else {
      const width = Math.max(...checks.map(c => c.name.length));
      console.log();
      for (const check of checks) {
        console.log(
          `${SYMBOL[check.level]} ${chalk.bold(check.name.padEnd(width))}  ${
            check.level === "ok" ? chalk.dim(check.detail) : check.detail
          }`,
        );
        if (check.hint && check.level !== "ok") {
          console.log(`  ${chalk.dim("→")} ${chalk.dim(check.hint)}`);
        }
      }
      console.log();

      const failed = checks.filter(c => c.level === "fail").length;
      const warned = checks.filter(c => c.level === "warn").length;
      const passed = checks.length - failed - warned;
      const summary = `${passed} ok, ${warned} warning(s), ${failed} failure(s)`;
      console.log(
        failed > 0
          ? chalk.red(summary)
          : warned > 0
            ? chalk.yellow(summary)
            : chalk.green(summary),
      );
    }

    if (checks.some(c => c.level === "fail")) process.exit(1);
  });
