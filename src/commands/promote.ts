import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import {
  EnvironmentService,
  PROMOTE_ENV_STEPS,
  sortedPorts,
} from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { runSteps, renderMode } from "../lib/task-list.js";
import { parseSeedOption } from "../lib/seed-strategy.js";
import { DevflowError } from "../lib/errors.js";

/**
 * `devflow promote`: give a LITE environment its ports, database and deps.
 *
 * The first `devflow run` does this implicitly, which is the right default —
 * nothing heavy happens until you actually need it. But "provision it now,
 * while I go and do something else" is a different intent from "start the
 * servers", and the desktop app had a button for exactly that. It is also the
 * only way to choose the seed strategy for an environment herdr created.
 */
export const promoteCommand = new Command()
  .name("promote")
  .description(
    "Give a lite environment its ports, database and dependencies (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--apps <apps>", "Comma-separated apps to run (default: project's)")
  .option("--seed <strategy>", "Database seed: copy-main, fresh, snapshot:name")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow promote                       provision this checkout now
  $ devflow promote --seed fresh          migrate instead of copying data
  $ devflow promote my-env --json         machine-readable, no progress`,
  )
  .action(async (envName: string | undefined, options) => {
    const mode = renderMode({ json: options.json });
    try {
      const seed = await parseSeedOption(options.seed);
      const env = await resolveEnvironment({ name: envName });

      if (env.kind !== "LITE") {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `${env.name} already has its ports and database. Regenerate its .env files with \`devflow env-files\`, or destroy and recreate it.`,
        );
      }

      const service = new EnvironmentService(prisma);

      if (mode !== "silent") {
        console.log();
        console.log(colors.bold(`Provisioning ${env.name}`));
      }

      await runSteps({
        steps: PROMOTE_ENV_STEPS,
        mode,
        operation: onProgress =>
          service.promoteEnvironment(
            env.id,
            {
              seedStrategy: seed?.strategy,
              snapshotPath: seed?.snapshotPath,
              apps: options.apps
                ? options.apps.split(",").map((s: string) => s.trim())
                : undefined,
            },
            onProgress,
          ),
      });

      const full = await service.getEnvironment(env.id);

      if (options.json) {
        printJson({
          environment: env.name,
          kind: full?.kind ?? "FULL",
          status: full?.status ?? "RUNNING",
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
        `${colors.green("✔")} ${colors.bold(env.name)} is provisioned`,
      );
      for (const port of sortedPorts(full?.ports ?? [])) {
        console.log(
          `  ${colors.bold(port.appName)}: ${colors.cyan(`http://localhost:${port.port}`)}`,
        );
      }
      if (full?.database)
        console.log(`  ${colors.bold("postgres")}: ${colors.dim(full.database.url)}`);
      console.log();
      console.log(
        colors.dim("Run the dev servers with:"),
        colors.white(`devflow run ${env.name}`),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
