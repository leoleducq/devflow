import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma, parseJsonArray, parseJsonObject } from "../db/index.js";
import { ProcessService, EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { ensureFull } from "../lib/ensure-full.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";

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
  .option(
    "--json",
    "Print the resolved environment and its ports, then stream the servers' output",
  )
  .action(async (envName: string | undefined, options) => {
    try {
      const env = await ensureFull(
        await resolveEnvironment({ name: envName }),
        { quiet: options.json },
      );
      if (env.status !== "RUNNING") {
        throw new DevflowError(
          "ENVIRONMENT_NOT_RUNNING",
          `Environment ${env.name} is ${env.status.toLowerCase()}; start it first: devflow start ${env.name}`,
        );
      }

      const apps: string[] = options.apps
        ? options.apps.split(",").map((s: string) => s.trim())
        : parseJsonArray(env.apps);
      const ports: Record<string, number> = {};
      for (const port of env.ports) ports[port.appName] = port.port;

      // `run` holds the foreground, so --json cannot mean "one JSON value and
      // nothing else": it prints the resolved environment as a single line up
      // front, then the servers' interleaved output. That one line is what a
      // caller needs to know where to point a request.
      if (options.json) {
        printJson({
          environment: env.name,
          project: env.project?.name ?? null,
          branch: env.branch,
          worktreePath: env.worktreePath,
          databaseUrl: env.database?.url ?? null,
          apps,
          ports: apps
            .filter(app => ports[app])
            .map(app => ({ app, port: ports[app], url: `http://localhost:${ports[app]}` })),
        });
      } else {
        console.log(colors.bold(env.name));
        for (const app of apps) {
          if (ports[app])
            console.log(
              `  ${app}: ${colors.cyan(`http://localhost:${ports[app]}`)}`,
            );
        }
        console.log(colors.dim("Ctrl+C stops all services\n"));
      }

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
        if (!options.json) console.log(colors.dim("\nStopping services…"));
        await processes.stopProcesses(env.id);
        await prisma.$disconnect();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("SIGHUP", stop);

      await new Promise(() => {});
    } catch (error) {
      failCommand(error, options.json);
    }
  });
