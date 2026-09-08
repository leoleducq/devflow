import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { ProcessService } from "../services/index.js";

/**
 * `devflow kill-zombies`: dev servers (next, turbo, tsx, vite) that outlived
 * the `devflow run` that started them. Agents, the proxy and herdr are left
 * alone.
 */
export const killZombiesCommand = new Command()
  .name("kill-zombies")
  .description(
    "Kill orphaned dev servers (next/turbo/tsx/vite) without an owner",
  )
  .option("--dry-run", "List them without killing")
  .action(async options => {
    const processes = new ProcessService(prisma);
    const zombies = options.dryRun
      ? await processes.findZombies()
      : await processes.killZombies();
    if (zombies.length === 0) {
      console.log(chalk.green("No zombies"));
    } else {
      for (const z of zombies) {
        console.log(`${chalk.dim(String(z.pid).padStart(6))}  ${z.command}`);
      }
      console.log(
        options.dryRun
          ? chalk.yellow(`${zombies.length} zombie(s), not killed (--dry-run)`)
          : chalk.green(`Killed ${zombies.length} zombie(s)`),
      );
    }
    await prisma.$disconnect();
  });
