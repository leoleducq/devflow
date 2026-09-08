import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";

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
  .option("--json", "Machine-readable output")
  .action(async (path: string | undefined, options) => {
    try {
      const env = await resolveEnvironment({ name: options.name, cwd: path });
      const spinner = startSpinner(`Tearing down ${env.name}`, options.json);
      await new EnvironmentService(prisma).teardownEnvironment(env.id);
      spinner.succeed(
        colors.green(`Environment ${colors.bold(env.name)} released`),
      );
      if (options.json)
        printJson({
          environment: env.name,
          worktreePath: env.worktreePath,
          released: true,
        });
    } catch (error) {
      if (options.quiet) return;
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
