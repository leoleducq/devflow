import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import {
  EnvironmentService,
  CREATE_ENV_STEPS,
  sortedPorts,
} from "../services/index.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { runSteps, renderMode } from "../lib/task-list.js";
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
  .addHelpText(
    "after",
    `
Examples:
  $ devflow create myapp feat/login          worktree, ports, database, deps
  $ devflow create myapp fix/bug --seed fresh
  $ devflow create myapp feat/x --json       machine-readable, no progress`,
  )
  .action(async (projectName: string, branch: string, cmdOptions) => {
    const mode = renderMode({ json: cmdOptions.json });

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

      if (mode !== "silent") {
        console.log();
        console.log(colors.bold(`Creating ${branch} in ${projectName}`));
      }

      // The same six steps as `provision`, shown the same way: one line each,
      // with its own elapsed time, so a four-minute `pnpm install` is visible
      // as itself rather than as a spinner that seems stuck.
      const created = await runSteps({
        steps: CREATE_ENV_STEPS,
        mode,
        operation: onProgress =>
          environmentService.createEnvironment(
            {
              projectId: project.id,
              branch,
              apps: cmdOptions.apps
                ? cmdOptions.apps.split(",").map((s: string) => s.trim())
                : undefined,
              seedStrategy,
              skipInstall: cmdOptions.skipInstall,
            },
            onProgress,
          ),
      });

      // Re-fetch with full relations
      const env = await environmentService.getEnvironment(created.id);
      if (!env) throw new Error("Environment created but could not be fetched");

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
      console.log(
        `${colors.green("✔")} Environment ${colors.bold(env.name)} created`,
      );
      console.log();
      console.log(colors.bold("Environment:"), colors.cyan(env.name));
      console.log(colors.bold("Branch:"), env.branch);
      console.log(colors.bold("Worktree:"), env.worktreePath);

      if (env.database) {
        console.log();
        console.log(colors.bold("Database:"));
        console.log(`  URL: ${env.database.url}`);
        console.log(`  Port: ${env.database.port}`);
      }

      if (env.ports.length > 0) {
        console.log();
        console.log(colors.bold("Services:"));
        for (const port of env.ports) {
          console.log(
            `  ${port.appName}: ${colors.cyan(`http://localhost:${port.port}`)}`,
          );
        }
      }

      console.log();
      console.log(
        colors.dim("Start services with:"),
        colors.white(`devflow run ${env.name}`),
      );
    } catch (error) {
      failCommand(error, cmdOptions.json);
    } finally {
      await prisma.$disconnect();
    }
  });
