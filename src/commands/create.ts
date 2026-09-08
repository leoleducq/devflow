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
import { parseSeedOption } from "../lib/seed-strategy.js";

export const createCommand = new Command()
  .name("create")
  .description("Create a new development environment")
  .argument("<project>", "Project name")
  .argument("[branch]", "Branch name (omit when --pr supplies it)")
  .option(
    "--pr <number>",
    "Create the environment from a GitHub pull request (needs gh)",
  )
  .option(
    "--apps <apps>",
    "Comma-separated list of apps to run (e.g., api,web)",
  )
  .option(
    "--seed <strategy>",
    "Database seed strategy (copy-main, fresh, snapshot:name)",
  )
  .option("--base <branch>", "Base branch to cut from and diff against")
  .option("--skip-install", "Skip installing dependencies")
  .option(
    "--lite",
    "Worktree only; ports, database and deps come with the first `devflow run`",
  )
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow create myapp feat/login          worktree, ports, database, deps
  $ devflow create myapp fix/bug --seed fresh
  $ devflow create myapp --pr 412            branch, base and title from the PR
  $ devflow create myapp feat/x --json       machine-readable, no progress`,
  )
  .action(async (projectName: string, branch: string | undefined, cmdOptions) => {
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

      // A PR supplies the branch, the base and the title; a branch argument
      // supplies only the branch. One of the two has to be there, and asking
      // for it is not an option — most callers here are agents.
      const prNumber = cmdOptions.pr ? Number(cmdOptions.pr) : undefined;
      if (prNumber !== undefined && !Number.isInteger(prNumber)) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--pr expects a pull request number, got '${cmdOptions.pr}'`,
        );
      }
      if (!branch && prNumber === undefined) {
        throw new DevflowError(
          "INPUT_REQUIRED",
          "A branch is required. Pass one as the second argument, or use --pr <number>.",
        );
      }

      const environmentService = new EnvironmentService(prisma);

      const seed = await parseSeedOption(cmdOptions.seed);

      if (mode !== "silent") {
        console.log();
        console.log(
          colors.bold(
            prNumber !== undefined
              ? `Creating an environment for PR #${prNumber} in ${projectName}`
              : `Creating ${branch} in ${projectName}`,
          ),
        );
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
              prNumber,
              baseBranch: cmdOptions.base,
              apps: cmdOptions.apps
                ? cmdOptions.apps.split(",").map((s: string) => s.trim())
                : undefined,
              seedStrategy: seed?.strategy,
              snapshotPath: seed?.snapshotPath,
              skipInstall: cmdOptions.skipInstall,
              kind: cmdOptions.lite ? "LITE" : "FULL",
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
          baseBranch: env.baseBranch,
          pullRequest: env.prNumber
            ? { number: env.prNumber, title: env.prTitle, url: env.prUrl }
            : null,
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
      if (env.prNumber) {
        console.log(
          colors.bold("Pull request:"),
          `#${env.prNumber} ${env.prTitle ?? ""}`.trim(),
        );
        if (env.prUrl) console.log(colors.bold("URL:"), colors.cyan(env.prUrl));
      }
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
