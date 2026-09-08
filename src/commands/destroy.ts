import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { failCommand, printJson, quietSpinner } from "../lib/json-output.js";
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

      // A prompt would hang a caller reading JSON off a pipe, so --json
      // demands the same explicit consent as a script does.
      if (!options.yes) {
        if (options.json) {
          throw new DevflowError(
            "CONFIRMATION_REQUIRED",
            `Destroying ${envName} removes its worktree and database; pass --yes to confirm`,
          );
        }
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
          {
            type: "confirm",
            name: "confirm",
            message: `Destroy environment ${chalk.cyan(envName)}? This will remove the worktree and database.`,
            default: false,
          },
        ]);
        if (!confirm) {
          console.log(chalk.yellow("Cancelled"));
          return;
        }
      }

      const spinner = quietSpinner(`Destroying ${envName}…`, options.json);
      await environmentService.destroyEnvironment(env.id);
      spinner.succeed(chalk.green(`Environment '${envName}' destroyed`));
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
