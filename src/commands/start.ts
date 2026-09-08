import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { EnvironmentService, sortedPorts } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import {
  failCommand,
  printJson,
  startSpinner,
} from "../lib/json-output.js";

export const startCommand = new Command()
  .name("start")
  .description("Start an environment (this checkout by default)")
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--json", "Machine-readable output")
  .action(async (envName: string | undefined, options) => {
    const spinner = startSpinner("Starting environment…", options.json);
    try {
      const env = await resolveEnvironment({ name: envName });
      spinner.update(`Starting ${env.name}…`);
      const service = new EnvironmentService(prisma);
      await service.startEnvironment(env.id);
      spinner.succeed(colors.green(`${env.name} started`));
      if (options.json) {
        const started = await service.getEnvironment(env.id);
        printJson({
          environment: env.name,
          status: started?.status ?? "RUNNING",
          worktreePath: env.worktreePath,
          databaseUrl: started?.database?.url ?? null,
          ports: sortedPorts(started?.ports ?? []).map(p => ({
            app: p.appName,
            port: p.port,
          })),
        });
      }
    } catch (error) {
      spinner.stop();
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
