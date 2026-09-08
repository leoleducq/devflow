import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import {
  EnvironmentService,
  PortlessService,
  appUrl,
} from "../services/index.js";
import type { PortlessRoute } from "../services/index.js";
import { failCommand, printJson, redact } from "../lib/json-output.js";
import { printTable } from "../lib/table.js";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all development environments")
  .option("-p, --project <name>", "Filter by project name")
  .option("--json", "Machine-readable output")
  .action(async options => {
    try {
      const environmentService = new EnvironmentService(prisma);

      let projectId: string | undefined;
      if (options.project) {
        const project = await prisma.project.findUnique({
          where: { name: options.project },
        });
        projectId = project?.id;
      }

      const environments = await environmentService.listEnvironments(projectId);

      // One `portless list` for the whole table, and only when some project
      // on it actually opted in.
      const routes: PortlessRoute[] = environments.some(
        env => env.project?.portless,
      )
        ? await new PortlessService().listRoutes().catch(() => [])
        : [];
      const urlOf = (
        env: (typeof environments)[number],
        app: string,
        port: number,
      ): string =>
        appUrl({
          app,
          port,
          environment: env.name,
          project: env.project,
          routes,
        });

      if (options.json) {
        printJson(
          redact(
            environments.map(env => ({
              ...env,
              ports: env.ports.map(p => ({
                ...p,
                url: urlOf(env, p.appName, p.port),
              })),
            })),
          ),
        );
        return;
      }

      if (environments.length === 0) {
        console.log(colors.yellow("No environments found"));
        console.log(
          colors.dim("Provision this checkout with:"),
          colors.white("devflow provision"),
        );
        return;
      }

      // One row per environment rather than a paragraph each: the whole point
      // of `list` is comparing them, and six labelled blocks do not compare.
      const paint = (status: string): string =>
        status === "RUNNING"
          ? colors.green(status)
          : status === "STOPPED"
            ? colors.yellow(status)
            : status === "ERROR"
              ? colors.red(status)
              : colors.gray(status);

      console.log();
      printTable(
        environments.map(env => [
          colors.bold(env.name),
          paint(env.status),
          env.project?.name ?? colors.dim("unknown"),
          env.branch,
          env.database ? `:${env.database.port}` : colors.dim("-"),
          env.ports.length > 0
            ? env.ports
                .map(p =>
                  env.project?.portless
                    ? colors.cyan(urlOf(env, p.appName, p.port))
                    : `${p.appName}:${colors.cyan(String(p.port))}`,
                )
                .join(" ")
            : colors.dim("-"),
        ]),
        {
          columns: [
            { header: "NAME" },
            { header: "STATUS" },
            { header: "PROJECT" },
            { header: "BRANCH" },
            { header: "DB" },
            { header: "PORTS" },
          ],
        },
      );
      console.log();
      console.log(colors.dim(`${environments.length} environment(s)`));
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
