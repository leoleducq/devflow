import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";

/**
 * `devflow teardown [path]`: release what `provision` created (processes,
 * database, ports) and forget the environment. The checkout stays: herdr
 * removes the worktree itself, and it calls this first.
 */
export const teardownCommand = new Command()
  .name("teardown")
  .description(
    "Release an environment's database and ports, keeping the checkout",
  )
  .argument(
    "[path]",
    "Checkout of the environment (default: current directory)",
  )
  .option("--name <env-name>", "Target by environment name instead of path")
  .option("--quiet", "Exit silently when the path is not an environment")
  .action(async (path: string | undefined, options) => {
    try {
      const env = await resolveEnvironment({ name: options.name, cwd: path });
      const spinner = ora(`Tearing down ${env.name}`).start();
      await new EnvironmentService(prisma).teardownEnvironment(env.id);
      spinner.succeed(
        chalk.green(`Environment ${chalk.bold(env.name)} released`),
      );
    } catch (error) {
      if (options.quiet) return;
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
