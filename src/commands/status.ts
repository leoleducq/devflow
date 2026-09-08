import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma, parseJsonArray } from "../db/index.js";
import {
  ConfigService,
  EnvironmentService,
  PortlessService,
  ProcessService,
  appUrl,
  sortedPorts,
} from "../services/index.js";
import type { PortlessRoute } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { printPairs, printTable } from "../lib/table.js";

/**
 * `devflow status`: where things stand, in one screen.
 *
 * The desktop dashboard answered two questions the CLI could not: how many
 * environments exist and in what state, and which one the port proxies are
 * pointing at right now. `devflow list` shows the first as a table but says
 * nothing about the active one — and "why is localhost:3000 the wrong app"
 * is the question that costs the most time.
 *
 * With no argument it reports the machine; with one (or from inside a
 * worktree) it reports that environment in detail.
 */
export const statusCommand = new Command()
  .name("status")
  .description("Show the active environment and what is running")
  .argument(
    "[env-name]",
    "Report one environment in detail (default: this checkout, else the machine)",
  )
  .option("-a, --all", "Report the machine even from inside a worktree")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow status              this environment, or the machine outside one
  $ devflow status --all        counts and the active environment
  $ devflow status --json       machine-readable`,
  )
  .action(async (envName: string | undefined, options) => {
    try {
      const config = await new ConfigService(prisma).getOrCreateConfig();
      const active = config.activeEnvironmentId
        ? await prisma.environment.findUnique({
            where: { id: config.activeEnvironmentId },
            select: { name: true },
          })
        : null;

      // Inside a worktree the useful answer is "this one"; outside it, or
      // with --all, it is the machine.
      const target = options.all
        ? null
        : await resolveEnvironment({ name: envName }).catch(() => null);

      if (target) {
        await reportEnvironment(target, active?.name ?? null, !!options.json);
        return;
      }

      await reportMachine(active?.name ?? null, !!options.json);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * The portless routes, when this environment's project opted in. `[]` for
 * everyone else, so a project without portless never shells out at all.
 */
async function routesFor(
  usesPortless: boolean,
): Promise<PortlessRoute[]> {
  if (!usesPortless) return [];
  return new PortlessService().listRoutes().catch(() => []);
}

/** One environment: its resources, its dev servers, whether it is active. */
async function reportEnvironment(
  env: Awaited<ReturnType<typeof resolveEnvironment>>,
  activeName: string | null,
  json: boolean,
): Promise<void> {
  const processes = await new ProcessService(prisma).getProcesses(env.id);
  const running = processes.filter(p => p.status === "RUNNING");
  const routes = await routesFor(env.project?.portless ?? false);
  const urlOf = (app: string, port: number): string =>
    appUrl({ app, port, environment: env.name, project: env.project, routes });

  if (json) {
    printJson({
      environment: env.name,
      project: env.project?.name ?? null,
      branch: env.branch,
      baseBranch: env.baseBranch,
      kind: env.kind,
      status: env.status,
      active: activeName === env.name,
      worktreePath: env.worktreePath,
      pullRequest: env.prNumber
        ? { number: env.prNumber, title: env.prTitle, url: env.prUrl }
        : null,
      databaseUrl: env.database?.url ?? null,
      apps: parseJsonArray(env.apps),
      portless: env.project?.portless ?? false,
      ports: sortedPorts(env.ports).map(p => ({
        app: p.appName,
        port: p.port,
        url: urlOf(p.appName, p.port),
      })),
      processes: processes.map(p => ({
        app: p.appName,
        status: p.status,
        pid: p.pid,
        port: p.port,
      })),
    });
    return;
  }

  console.log();
  console.log(
    `${colors.bold.underline(env.name)}${activeName === env.name ? ` ${colors.green("(active)")}` : ""}`,
  );
  console.log();
  printPairs([
    ["project", env.project?.name ?? colors.dim("unknown")],
    ["branch", `${env.branch} ${colors.dim(`← ${env.baseBranch}`)}`],
    ["kind", env.kind],
    ["status", paintStatus(env.status)],
    ["worktree", colors.dim(env.worktreePath)],
    ...(env.prNumber
      ? ([["pull request", `#${env.prNumber} ${env.prTitle ?? ""}`.trim()]] as Array<
          [string, string]
        >)
      : []),
    [
      "database",
      env.database ? colors.dim(env.database.url) : colors.dim("none"),
    ],
    [
      "dev servers",
      running.length > 0
        ? colors.green(`${running.length} running`)
        : colors.dim("none running"),
    ],
  ]);

  if (env.ports.length > 0) {
    console.log();
    for (const port of sortedPorts(env.ports)) {
      const proc = processes.find(p => p.appName === port.appName);
      const url = urlOf(port.appName, port.port);
      // Behind a portless URL the port is still worth showing: it is what
      // the dev server bound, and what to curl when the proxy misbehaves.
      const behind = url.startsWith("https")
        ? ` ${colors.dim(`→ :${port.port}`)}`
        : "";
      console.log(
        `  ${colors.bold(port.appName.padEnd(8))} ${colors.cyan(url)}${behind} ${
          proc?.status === "RUNNING"
            ? colors.green("running")
            : colors.dim("stopped")
        }`,
      );
    }
  }
  console.log();
}

/** The machine: how many environments in each state, and the active one. */
async function reportMachine(
  activeName: string | null,
  json: boolean,
): Promise<void> {
  const [environments, projectCount] = await Promise.all([
    new EnvironmentService(prisma).listEnvironments(),
    prisma.project.count(),
  ]);

  const counts = environments.reduce<Record<string, number>>((acc, env) => {
    acc[env.status] = (acc[env.status] ?? 0) + 1;
    return acc;
  }, {});

  if (json) {
    printJson({
      projects: projectCount,
      environments: {
        total: environments.length,
        running: counts.RUNNING ?? 0,
        stopped: counts.STOPPED ?? 0,
        creating: counts.CREATING ?? 0,
        error: counts.ERROR ?? 0,
        lite: environments.filter(env => env.kind === "LITE").length,
      },
      activeEnvironment: activeName,
    });
    return;
  }

  console.log();
  printPairs([
    ["projects", String(projectCount)],
    ["environments", String(environments.length)],
    ["running", colors.green(String(counts.RUNNING ?? 0))],
    ["stopped", colors.yellow(String(counts.STOPPED ?? 0))],
    ...(counts.ERROR
      ? ([["error", colors.red(String(counts.ERROR))]] as Array<[string, string]>)
      : []),
    [
      "active",
      activeName
        ? colors.green(activeName)
        : colors.dim("none — original ports forward nowhere"),
    ],
  ]);

  if (environments.length > 0) {
    console.log();
    printTable(
      environments
        .slice(0, 10)
        .map(env => [
          activeName === env.name ? colors.green("→") : " ",
          colors.bold(env.name),
          paintStatus(env.status),
          colors.dim(env.branch),
        ]),
      { columns: [{ header: "" }, { header: "NAME" }, { header: "STATUS" }, { header: "BRANCH" }] },
    );
    if (environments.length > 10)
      console.log(colors.dim(`… and ${environments.length - 10} more; see devflow list`));
  }
  console.log();
}

const paintStatus = (status: string): string =>
  status === "RUNNING"
    ? colors.green(status)
    : status === "STOPPED"
      ? colors.yellow(status)
      : status === "ERROR"
        ? colors.red(status)
        : colors.gray(status);
