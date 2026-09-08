import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import {
  EnvironmentService,
  CREATE_ENV_STEPS,
  PROMOTE_ENV_STEPS,
  sortedPorts,
} from "../services/index.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { runSteps, renderMode } from "../lib/task-list.js";
import { parseSeedOption } from "../lib/seed-strategy.js";

/**
 * `devflow provision [path]`: give an existing checkout everything it needs
 * to run. herdr calls this when it creates a worktree; it also works by hand
 * on any checkout of a registered project.
 *
 * Six steps happen here and any of them can be the slow one, so they are
 * shown as a checklist rather than a spinner that overwrites itself: what
 * already succeeded stays on screen, and a failure is attached to the step
 * that caused it.
 */
export const provisionCommand = new Command()
  .name("provision")
  .description(
    "Provision an existing checkout as an environment (ports, database, .env, deps)",
  )
  .argument("[path]", "Checkout to provision (default: current directory)")
  .option("--apps <apps>", "Comma-separated apps to run (default: project's)")
  .option("--seed <strategy>", "Database seed: copy-main, fresh, snapshot:name")
  .option("--base <branch>", "Base branch for diffs (default: the project's defaultBaseBranch)")
  .option("--skip-install", "Skip pnpm install and prisma generate")
  .option(
    "--lite",
    "Register the checkout only; ports, database and deps come with the first `devflow run`",
  )
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow provision                     provision the current checkout
  $ devflow provision --lite              register it, provision on first run
  $ devflow provision --seed fresh        run migrations instead of copying data
  $ devflow provision --json              machine-readable, no progress output`,
  )
  .action(async (path: string | undefined, options) => {
    const worktreePath = path ?? process.cwd();
    const mode = renderMode({ json: options.json });

    try {
      const service = new EnvironmentService(prisma);
      const seed = await parseSeedOption(options.seed);

      if (mode !== "silent") {
        console.log();
        console.log(colors.bold(`Provisioning ${worktreePath}`));
      }

      let env = await runSteps({
        steps: CREATE_ENV_STEPS,
        mode,
        operation: onProgress =>
          service.adoptWorktree(
            {
              worktreePath,
              apps: options.apps
                ? options.apps.split(",").map((s: string) => s.trim())
                : undefined,
              seedStrategy: seed?.strategy,
              snapshotPath: seed?.snapshotPath,
              skipInstall: options.skipInstall,
              baseBranch: options.base,
              kind: options.lite ? "LITE" : "FULL",
            },
            onProgress,
          ),
      });

      // Already registered as LITE and asked for the full thing: promote.
      // The worktree step does not run again, so the list is the shorter one.
      if (env.kind === "LITE" && !options.lite) {
        env = await runSteps({
          steps: PROMOTE_ENV_STEPS,
          mode,
          operation: onProgress =>
            service.promoteEnvironment(
              env.id,
              {
                seedStrategy: seed?.strategy,
                snapshotPath: seed?.snapshotPath,
                apps: options.apps?.split(","),
              },
              onProgress,
            ),
        });
      }

      const full = await service.getEnvironment(env.id);

      if (options.json) {
        printJson({
          environment: env.name,
          project: full?.project?.name ?? null,
          branch: env.branch,
          kind: env.kind,
          status: env.status,
          worktreePath: env.worktreePath,
          databaseUrl: full?.database?.url ?? null,
          ports: sortedPorts(full?.ports ?? []).map(p => ({
            app: p.appName,
            port: p.port,
          })),
        });
        return;
      }

      console.log();
      console.log(
        `${colors.green("✔")} Environment ${colors.bold(env.name)} ${
          env.kind === "LITE" ? "registered (lite)" : "ready"
        }`,
      );
      for (const port of sortedPorts(full?.ports ?? [])) {
        console.log(
          `  ${colors.bold(port.appName)}: ${colors.cyan(`http://localhost:${port.port}`)}`,
        );
      }
      if (full?.database) {
        console.log(
          `  ${colors.bold("postgres")}: ${colors.dim(full.database.url)}`,
        );
      }
      console.log(
        colors.dim(
          env.kind === "LITE"
            ? "\nPorts, database and deps are provisioned by the first: devflow run"
            : "\nRun the dev servers with: devflow run",
        ),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
