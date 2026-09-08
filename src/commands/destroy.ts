import { Command } from "commander";
import { colors } from "../lib/colors.js";
import * as prompts from "../lib/interactive.js";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";

export const destroyCommand = new Command()
  .name("destroy")
  .description("Destroy an environment completely")
  .argument("<env-name>", "Environment name")
  .option("-y, --yes", "Skip confirmation")
  .option("--json", "Machine-readable output")
  .action(async (envName: string, options) => {
    try {
      const environmentService = new EnvironmentService(prisma);
      const env = await environmentService.getEnvironmentByName(envName);
      if (!env)
        throw new DevflowError(
          "ENVIRONMENT_NOT_FOUND",
          `Environment '${envName}' not found`,
        );

      // Destroying is irreversible, so consent is never assumed. A caller
      // that cannot be asked — a pipe, CI, --json — has to say --yes up
      // front rather than have the command block on a question nobody will
      // ever see.
      if (!options.yes) {
        if (!prompts.canPrompt({ json: options.json })) {
          throw new DevflowError(
            "CONFIRMATION_REQUIRED",
            `Destroying ${envName} removes its worktree and database; pass --yes to confirm`,
          );
        }
        const confirmed = await prompts.confirm({
          message: `Destroy environment ${envName}? This removes the worktree and database.`,
          initialValue: false,
        });
        if (!confirmed) {
          console.log(colors.yellow("Cancelled"));
          return;
        }
      }

      const spinner = startSpinner(`Destroying ${envName}…`, options.json);
      await environmentService.destroyEnvironment(env.id);
      spinner.succeed(colors.green(`Environment '${envName}' destroyed`));
      if (options.json)
        printJson({
          environment: envName,
          worktreePath: env.worktreePath,
          destroyed: true,
        });
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
