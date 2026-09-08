import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { EnvironmentService, sortedPorts } from "../services/index.js";
import { failCommand, printJson, quietSpinner } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";
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
  .option("--json", "Machine-readable output")
  .action(async (projectName: string, branch: string, cmdOptions) => {
    const spinner = quietSpinner("Creating environment…", cmdOptions.json);

    try {
      const project = await prisma.project.findUnique({
        where: { name: projectName },
      });

      if (!project) {
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${projectName}' not found. Register it first with: devflow project add`,
        );
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
      if (!env) throw new Error("Environment created but could not be fetched");

      spinner.succeed(chalk.green("Environment created successfully!"));

      if (cmdOptions.json) {
        printJson({
          environment: env.name,
          project: projectName,
          branch: env.branch,
          kind: env.kind,
          status: env.status,
          worktreePath: env.worktreePath,
          databaseUrl: env.database?.url ?? null,
          ports: sortedPorts(env.ports).map(p => ({
            app: p.appName,
            port: p.port,
          })),
        });
        return;
      }

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
      failCommand(error, cmdOptions.json);
    } finally {
      await prisma.$disconnect();
    }
  });
