import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { prisma } from "../db/index.js";
import { EnvironmentService, CREATE_ENV_STEPS } from "../services/index.js";
import type { CreateEnvStepId, CreateEnvProgress } from "../services/index.js";

const SEED_STRATEGY_MAP: Record<string, string> = {
  "copy-main": "COPY_MAIN",
  fresh: "FRESH_MIGRATE",
};

const STEP_LABEL: Record<CreateEnvStepId, string> = Object.fromEntries(
  CREATE_ENV_STEPS.map(s => [s.id, s.label]),
) as Record<CreateEnvStepId, string>;

/**
 * `devflow provision [path]`: give an existing checkout everything it needs
 * to run. herdr calls this when it creates a worktree; it also works by hand
 * on any checkout of a registered project.
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
  .action(async (path: string | undefined, options) => {
    const worktreePath = path ?? process.cwd();
    const spinner = ora(`Provisioning ${worktreePath}`).start();

    try {
      const service = new EnvironmentService(prisma);
      const seedStrategy = options.seed
        ? (SEED_STRATEGY_MAP[options.seed] ??
          (options.seed.startsWith("snapshot:") ? "SNAPSHOT" : undefined))
        : undefined;

      const onStep = (event: CreateEnvProgress) => {
        if (event.type === "step" && event.status === "start") {
          spinner.text = STEP_LABEL[event.id] ?? event.id;
        }
      };
      let env = await service.adoptWorktree(
        {
          worktreePath,
          apps: options.apps
            ? options.apps.split(",").map((s: string) => s.trim())
            : undefined,
          seedStrategy,
          skipInstall: options.skipInstall,
          baseBranch: options.base,
          kind: options.lite ? "LITE" : "FULL",
        },
        onStep,
      );
      // Already registered as LITE and asked for the full thing: promote.
      if (env.kind === "LITE" && !options.lite) {
        env = await service.promoteEnvironment(
          env.id,
          { seedStrategy, apps: options.apps?.split(",") },
          onStep,
        );
      }

      spinner.succeed(
        chalk.green(
          `Environment ${chalk.bold(env.name)} ${env.kind === "LITE" ? "registered (lite)" : "ready"}`,
        ),
      );
      const full = await service.getEnvironment(env.id);
      for (const port of full?.ports ?? []) {
        console.log(
          `  ${chalk.bold(port.appName)}: ${chalk.cyan(`http://localhost:${port.port}`)}`,
        );
      }
      if (full?.database) {
        console.log(
          `  ${chalk.bold("postgres")}: ${chalk.dim(full.database.url)}`,
        );
      }
      console.log(
        chalk.dim(
          env.kind === "LITE"
            ? "\nPorts, database and deps are provisioned by the first: devflow run"
            : "\nRun the dev servers with: devflow run",
        ),
      );
    } catch (error) {
      spinner.fail(chalk.red("Provisioning failed"));
      if (error instanceof Error) console.error(chalk.red(error.message));
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
