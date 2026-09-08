import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson } from "../lib/json-output.js";

/**
 * `devflow env-files`: regenerate the checkout's `.env` files from the main
 * checkout's, with this environment's database and ports. Restart the dev
 * servers afterwards: Next.js reads NEXT_PUBLIC_* at startup.
 */
export const envFilesCommand = new Command()
  .name("env-files")
  .description(
    "Regenerate an environment's .env files (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--all", "Every environment of every project")
  .option("--json", "Machine-readable output")
  .action(async (envName: string | undefined, options) => {
    try {
      const service = new EnvironmentService(prisma);
      const targets = options.all
        ? await service.listEnvironments()
        : [await resolveEnvironment({ name: envName })];
      for (const env of targets) {
        await service.regenerateEnvFiles(env.id);
        if (!options.json)
          console.log(
            `${chalk.green("✔")} ${env.name} ${chalk.dim(env.kind === "LITE" ? "(main checkout's files)" : "")}`,
          );
      }
      if (options.json) {
        printJson(
          targets.map(env => ({
            environment: env.name,
            kind: env.kind,
            worktreePath: env.worktreePath,
            regenerated: true,
          })),
        );
        return;
      }
      if (targets.some(e => e.kind !== "LITE"))
        console.log(
          chalk.dim("Restart the dev servers to pick the new values up."),
        );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
