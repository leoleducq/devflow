import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";

export const stopCommand = new Command()
  .name("stop")
  .description("Stop an environment (this checkout by default)")
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--json", "Machine-readable output")
  .action(async (envName: string | undefined, options) => {
    const spinner = startSpinner("Stopping environment…", options.json);
    try {
      const env = await resolveEnvironment({ name: envName });
      spinner.update(`Stopping ${env.name}…`);
      const stopped = await new EnvironmentService(prisma).stopEnvironment(
        env.id,
      );
      spinner.succeed(colors.green(`${env.name} stopped`));
      if (options.json)
        printJson({
          environment: env.name,
          status: stopped.status,
          worktreePath: env.worktreePath,
        });
    } catch (error) {
      spinner.stop();
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
