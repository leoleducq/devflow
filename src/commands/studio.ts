import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import fs from "fs-extra";
import { EnvironmentService } from "../services/index.js";
import { prisma } from "../db/index.js";
import { startSpinner, failCommand } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";
import {
  resolvePackageManager,
  execBinaryArgv,
} from "../lib/package-manager.js";

export const studioCommand = new Command()
  .name("studio")
  .description("Open Prisma Studio for an environment's database")
  .argument("<env-name>", "Environment name")
  .option("-p, --port <port>", "Prisma Studio port", "5555")
  .action(async (envName: string, options: { port: string }) => {
    const spinner = startSpinner("Loading environment…");

    try {
      const envService = new EnvironmentService(prisma);
      const env = await envService.getEnvironmentByName(envName);

      if (!env)
        throw new DevflowError(
          "ENVIRONMENT_NOT_FOUND",
          `Environment '${envName}' not found`,
        );
      if (!env.database)
        throw new DevflowError(
          "NO_DATABASE",
          `Environment '${envName}' has no database`,
        );

      // Find the prisma schema in the worktree.
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

      if (!schemaPath) throw new Error("Prisma schema not found in worktree");

      spinner.succeed("Launching Prisma Studio");

      console.log();
      console.log(colors.bold("Database:"), colors.cyan(env.database.url));
      console.log(
        colors.bold("Studio:"),
        colors.cyan(`http://localhost:${options.port}`),
      );
      console.log();
      console.log(colors.dim("Press Ctrl+C to stop"));

      const manager = await resolvePackageManager(
        env.worktreePath,
        env.project?.packageManager,
      );
      const studio = execBinaryArgv(manager, "prisma", [
        "studio",
        "--port",
        options.port,
      ]);

      try {
        execFileSync(studio.command, studio.args, {
          cwd: dirname(schemaPath),
          env: {
            ...process.env,
            DATABASE_URL: env.database.url,
          },
          stdio: "inherit",
        });
      } catch {
        // User pressed Ctrl+C.
      }
    } catch (error) {
      spinner.stop();
      failCommand(error);
    } finally {
      await prisma.$disconnect();
    }
  });
