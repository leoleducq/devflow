import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";

export const destroyCommand = new Command()
  .name("destroy")
  .description("Destroy an environment completely")
  .argument("<env-name>", "Environment name")
  .option("-y, --yes", "Skip confirmation")
  .action(async (envName: string, options) => {
    try {
      const environmentService = new EnvironmentService(prisma);
      const env = await environmentService.getEnvironmentByName(envName);

      if (!env) {
        console.error(chalk.red(`Environment '${envName}' not found`));
        process.exit(1);
      }

      if (!options.yes) {
        const { confirm } = await inquirer.prompt([
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

      const spinner = ora(`Destroying ${envName}...`).start();
      await environmentService.destroyEnvironment(env.id);
      spinner.succeed(chalk.green(`Environment '${envName}' destroyed`));
    } catch (error) {
      console.error(chalk.red("Failed to destroy environment"));
      if (error instanceof Error) {
        console.error(chalk.red(error.message));
      }
      process.exit(1);
    }
  });
