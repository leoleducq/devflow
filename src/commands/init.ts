import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { prisma } from "../db/index.js";
import { checkTool, which } from "../lib/checks.js";
import type { Check } from "../lib/checks.js";
import {
  inspectForRegistration,
  registerProject,
} from "../lib/register-project.js";

/**
 * Only what `init` itself needs. The full sweep — orphaned containers, the
 * state of every registered project — belongs to `devflow doctor`.
 */
async function prerequisites(): Promise<Check[]> {
  const checks: Check[] = [
    await checkTool({
      command: "git",
      required: true,
      hint: "DevFlow provisions git worktrees; install git first",
    }),
    await checkTool({
      command: "pnpm",
      required: true,
      hint: "DevFlow installs worktree dependencies and runs dev servers with pnpm; install it from https://pnpm.io/installation",
    }),
  ];

  if (await which("docker")) {
    checks.push({ name: "docker", level: "ok", detail: "installed" });
  } else {
    checks.push({
      name: "docker",
      level: "warn",
      detail: "not found on PATH",
      hint: "Environments need it for their Postgres; LITE environments work without it",
    });
  }

  return checks;
}

const SYMBOL = {
  ok: chalk.green("✔"),
  warn: chalk.yellow("!"),
  fail: chalk.red("✘"),
} as const;

export const initCommand = new Command()
  .name("init")
  .description(
    "Set DevFlow up for the project in this directory: check prerequisites, detect it, register it",
  )
  .argument("[path]", "Project directory (default: current directory)")
  .option("-y, --yes", "Accept everything detected without prompting")
  .action(async (pathArg: string | undefined, options) => {
    try {
      console.log();
      console.log(chalk.bold.underline("Prerequisites"));
      const checks = await prerequisites();
      const width = Math.max(...checks.map(c => c.name.length));
      for (const check of checks) {
        console.log(
          `  ${SYMBOL[check.level]} ${chalk.bold(check.name.padEnd(width))}  ${
            check.level === "ok" ? chalk.dim(check.detail) : check.detail
          }`,
        );
        if (check.hint && check.level !== "ok") {
          console.log(`    ${chalk.dim("→")} ${chalk.dim(check.hint)}`);
        }
      }

      if (checks.some(c => c.level === "fail")) {
        console.log();
        console.log(
          chalk.red(
            "Install the missing tools above, then run `devflow init` again.",
          ),
        );
        process.exit(1);
      }

      const spinner = ora("Inspecting the project…").start();
      const registration = await inspectForRegistration(
        pathArg ?? process.cwd(),
      );
      spinner.stop();

      const project = await registerProject(registration, {
        interactive: !options.yes,
      });

      console.log();
      console.log(chalk.green(`${chalk.bold(project.name)} is registered.`));
      console.log();
      console.log(chalk.bold("Next"));
      console.log(
        `  ${chalk.dim("provision this checkout")}   devflow provision`,
      );
      console.log(`  ${chalk.dim("run its dev servers")}       devflow run`);
      console.log(
        `  ${chalk.dim("review what was detected")}  devflow project get ${project.name}`,
      );
      console.log(
        `  ${chalk.dim("connect Linear")}            devflow project linear ${project.name}`,
      );
      console.log(`  ${chalk.dim("check the whole setup")}     devflow doctor`);
      console.log();
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
