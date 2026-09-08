import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { printJson, printJsonError, redact } from "../lib/json-output.js";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all development environments")
  .option("-p, --project <name>", "Filter by project name")
  .option("--json", "Machine-readable output")
  .action(async options => {
    try {
      const environmentService = new EnvironmentService(prisma);

      let projectId: string | undefined;
      if (options.project) {
        const project = await prisma.project.findUnique({
          where: { name: options.project },
        });
        projectId = project?.id;
      }

      const environments = await environmentService.listEnvironments(projectId);

      if (options.json) {
        printJson(redact(environments));
        return;
      }

      if (environments.length === 0) {
        console.log(chalk.yellow("No environments found"));
        console.log(
          chalk.dim("Provision this checkout with:"),
          chalk.white("devflow provision"),
        );
        return;
      }

      console.log();
      console.log(chalk.bold.underline("Active Environments"));
      console.log();

      for (const env of environments) {
        const statusColor =
          env.status === "RUNNING"
            ? chalk.green
            : env.status === "STOPPED"
              ? chalk.yellow
              : env.status === "ERROR"
                ? chalk.red
                : chalk.gray;

        console.log(chalk.bold(env.name), statusColor(`[${env.status}]`));
        console.log(chalk.dim("  Project:"), env.project?.name ?? "unknown");
        console.log(chalk.dim("  Branch:"), env.branch);

        if (env.database) {
          console.log(
            chalk.dim("  Database:"),
            `localhost:${env.database.port}`,
          );
        }

        if (env.ports.length > 0) {
          console.log(chalk.dim("  Services:"));
          for (const port of env.ports) {
            console.log(
              `    ${port.appName}: ${chalk.cyan(`http://localhost:${port.port}`)}`,
            );
          }
        }

        console.log();
      }

      console.log(chalk.dim(`Total: ${environments.length} environment(s)`));
    } catch (error) {
      if (options.json) printJsonError(error);
      else
        console.error(
          chalk.red(error instanceof Error ? error.message : String(error)),
        );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
