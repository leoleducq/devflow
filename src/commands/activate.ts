import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { ConfigService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";

/**
 * `devflow activate`: choose the environment the original app ports forward
 * to. Only records the choice; `devflow proxy` (always running) applies it.
 * herdr calls it with `--cwd --quiet` when a workspace gets focus, so the
 * proxy follows the workspace you are looking at.
 */
export const activateCommand = new Command()
  .name("activate")
  .description("Point the port proxies at an environment")
  .argument(
    "[env-name]",
    "Environment name (default: the environment of --cwd)",
  )
  .option("--cwd <path>", "Resolve the environment from this checkout")
  .option("--none", "Deactivate: proxies forward nowhere")
  .option("--quiet", "Exit silently when --cwd is not an environment")
  .action(async (envName: string | undefined, options) => {
    try {
      const config = await new ConfigService(prisma).getOrCreateConfig();
      if (options.none) {
        await prisma.devflowConfig.update({
          where: { id: config.id },
          data: { activeEnvironmentId: null },
        });
        console.log(chalk.green("No active environment"));
        return;
      }

      const env = await resolveEnvironment({ name: envName, cwd: options.cwd });
      if (config.activeEnvironmentId === env.id) {
        if (!options.quiet)
          console.log(chalk.dim(`${env.name} already active`));
        return;
      }
      await prisma.devflowConfig.update({
        where: { id: config.id },
        data: { activeEnvironmentId: env.id },
      });
      if (!options.quiet) {
        console.log(
          chalk.green(`Environment ${chalk.bold(env.name)} is active`),
        );
        console.log(
          chalk.dim("Original ports now forward to it (via devflow proxy)"),
        );
      }
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
