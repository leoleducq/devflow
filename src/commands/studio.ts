import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import fs from "fs-extra";
import { EnvironmentService } from "../services/index.js";
import { prisma } from "../db/index.js";

export const studioCommand = new Command()
  .name("studio")
  .description("Open Prisma Studio for an environment's database")
  .argument("<env-name>", "Environment name")
  .option("-p, --port <port>", "Prisma Studio port", "5555")
  .action(async (envName: string, options: { port: string }) => {
    const spinner = ora("Loading environment...").start();

    const envService = new EnvironmentService(prisma);
    const env = await envService.getEnvironmentByName(envName);

    if (!env) {
      spinner.fail(chalk.red(`Environment '${envName}' not found`));
      process.exit(1);
    }

    if (!env.database) {
      spinner.fail(chalk.red(`Environment '${envName}' has no database`));
      process.exit(1);
    }

    // Find the prisma schema in the worktree
    const possiblePaths = [
      join(env.worktreePath, "packages", "database", "prisma", "schema.prisma"),
      join(env.worktreePath, "prisma", "schema.prisma"),
    ];

    let schemaPath: string | undefined;
    for (const path of possiblePaths) {
      if (await fs.pathExists(path)) {
        schemaPath = path;
        break;
      }
    }

    if (!schemaPath) {
      spinner.fail(chalk.red("Prisma schema not found in worktree"));
      process.exit(1);
    }

    spinner.succeed(chalk.green("Launching Prisma Studio"));

    console.log();
    console.log(chalk.bold("Database:"), chalk.cyan(env.database.url));
    console.log(
      chalk.bold("Studio:"),
      chalk.cyan(`http://localhost:${options.port}`),
    );
    console.log();
    console.log(chalk.dim("Press Ctrl+C to stop"));

    try {
      execFileSync(
        "pnpm",
        ["exec", "prisma", "studio", "--port", options.port],
        {
          cwd: dirname(schemaPath),
          env: {
            ...process.env,
            DATABASE_URL: env.database.url,
          },
          stdio: "inherit",
        },
      );
    } catch {
      // User pressed Ctrl+C
    }
  });
