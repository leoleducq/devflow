import { Command } from "commander";
import chalk from "chalk";
import { prisma, parseJsonArray, parseJsonObject } from "../db/index.js";
import { ProcessService, EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { ensureFull } from "../lib/ensure-full.js";

/**
 * `devflow run`: the environment's dev servers, in the foreground, with
 * their output interleaved. Meant to live in a herdr pane: herdr keeps it
 * alive, the logs are right there, Ctrl+C stops everything.
 */
export const runCommand = new Command()
  .name("run")
  .description(
    "Run the dev servers of an environment (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option(
    "--apps <apps>",
    "Comma-separated apps to run (default: environment's)",
  )
  .action(async (envName: string | undefined, options) => {
    try {
      const env = await ensureFull(await resolveEnvironment({ name: envName }));
      if (env.status !== "RUNNING") {
        console.error(
          chalk.yellow(
            `Environment ${env.name} is ${env.status.toLowerCase()}; start it first: devflow start ${env.name}`,
          ),
        );
        process.exit(1);
      }

      const apps: string[] = options.apps
        ? options.apps.split(",").map((s: string) => s.trim())
        : parseJsonArray(env.apps);
      const ports: Record<string, number> = {};
      for (const port of env.ports) ports[port.appName] = port.port;

      console.log(chalk.bold(env.name));
      for (const app of apps) {
        if (ports[app])
          console.log(
            `  ${app}: ${chalk.cyan(`http://localhost:${ports[app]}`)}`,
          );
      }
      console.log(chalk.dim("Ctrl+C stops all services\n"));

      // Agents copy .env files around; make sure the servers start with this
      // environment's database and ports whatever happened to the files.
      await new EnvironmentService(prisma).regenerateEnvFiles(env.id);

      const processes = new ProcessService(prisma);
      await processes.startProcesses(
        env.id,
        env.worktreePath,
        apps,
        ports,
        env.database?.url ?? "",
        env.project?.dbEnvVarName ?? "DATABASE_URL",
        parseJsonObject<Record<string, string>>(env.project?.devCommands) ?? {},
      );

      const stop = async () => {
        console.log(chalk.dim("\nStopping services…"));
        await processes.stopProcesses(env.id);
        await prisma.$disconnect();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);

      await new Promise(() => {});
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    }
  });
