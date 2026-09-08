import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
const SEED_STRATEGY_MAP: Record<string, string> = {
  "copy-main": "COPY_MAIN",
  fresh: "FRESH_MIGRATE",
};

export const createCommand = new Command()
  .name("create")
  .description("Create a new development environment")
  .argument("<project>", "Project name")
  .argument("<branch>", "Branch name")
  .option(
    "--apps <apps>",
    "Comma-separated list of apps to run (e.g., api,web)",
  )
  .option(
    "--seed <strategy>",
    "Database seed strategy (copy-main, fresh, snapshot:name)",
  )
  .option("--skip-install", "Skip installing dependencies")
  .action(async (projectName: string, branch: string, cmdOptions) => {
    const spinner = ora("Creating environment...").start();

    try {
      const project = await prisma.project.findUnique({
        where: { name: projectName },
      });

      if (!project) {
        spinner.fail(
          chalk.red(
            `Project '${projectName}' not found. Register it first with: devflow project add`,
          ),
        );
        process.exit(1);
      }

      const environmentService = new EnvironmentService(prisma);

      let seedStrategy: string | undefined;
      if (cmdOptions.seed) {
        seedStrategy =
          SEED_STRATEGY_MAP[cmdOptions.seed] ??
          (cmdOptions.seed.startsWith("snapshot:") ? "SNAPSHOT" : undefined);
      }

      const created = await environmentService.createEnvironment({
        projectId: project.id,
        branch,
        apps: cmdOptions.apps
          ? cmdOptions.apps.split(",").map((s: string) => s.trim())
          : undefined,
        seedStrategy,
        skipInstall: cmdOptions.skipInstall,
      });

      // Re-fetch with full relations
      const env = await environmentService.getEnvironment(created.id);
      if (!env) {
        spinner.fail(chalk.red("Environment created but could not be fetched"));
        process.exit(1);
      }

      spinner.succeed(chalk.green("Environment created successfully!"));

      console.log();
      console.log(chalk.bold("Environment:"), chalk.cyan(env.name));
      console.log(chalk.bold("Branch:"), env.branch);
      console.log(chalk.bold("Worktree:"), env.worktreePath);

      if (env.database) {
        console.log();
        console.log(chalk.bold("Database:"));
        console.log(`  URL: ${env.database.url}`);
        console.log(`  Port: ${env.database.port}`);
      }

      if (env.ports.length > 0) {
        console.log();
        console.log(chalk.bold("Services:"));
        for (const port of env.ports) {
          console.log(
            `  ${port.appName}: ${chalk.cyan(`http://localhost:${port.port}`)}`,
          );
        }
      }

      console.log();
      console.log(
        chalk.dim("Start services with:"),
        chalk.white(`devflow run ${env.name}`),
      );
    } catch (error) {
      spinner.fail(chalk.red("Failed to create environment"));
      if (error instanceof Error) {
        console.error(chalk.red(error.message));
      }
      process.exit(1);
    }
  });
