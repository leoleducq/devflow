import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma, parseJsonObject } from "../db/index.js";
import { ProcessService, ProxyService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";
import { printTable } from "../lib/table.js";
import { DevflowError } from "../lib/errors.js";
import { commandOptions } from "../lib/command-options.js";

/**
 * Per-app process control.
 *
 * `devflow run` starts everything in the foreground and stops everything with
 * Ctrl+C, which is the right shape for a herdr pane but the wrong one for
 * "the api crashed, restart just that". The desktop UI had a start/stop/restart
 * button per app; these subcommands are the same thing without the window.
 *
 * They work across invocations because the processes are detached and their
 * pids live in the `process_info` table: a later `devflow ps stop api` finds
 * the pid there rather than in this process's memory.
 */

type EnvWithRelations = Awaited<ReturnType<typeof resolveEnvironment>>;

/** Everything one app needs to be (re)started, resolved from the environment. */
const appRunContext = (env: EnvWithRelations, app: string) => {
  const ports: Record<string, number> = {};
  for (const port of env.ports) ports[port.appName] = port.port;

  const port = ports[app];
  if (!port) {
    const known = env.ports.map(p => p.appName).join(", ");
    throw new DevflowError(
      "INVALID_ARGUMENT",
      `${env.name} has no port allocated for '${app}'${known ? `. Its apps: ${known}` : ""}`,
    );
  }

  return {
    port,
    databaseUrl: env.database?.url ?? "",
    dbEnvVarName: env.project?.dbEnvVarName ?? "DATABASE_URL",
    devCommand: (parseJsonObject<Record<string, string>>(
      env.project?.devCommands,
    ) ?? {})[app],
    originalPort: (parseJsonObject<Record<string, number>>(
      env.project?.appPorts,
    ) ?? {})[app],
  };
};

/** The rows `ps` prints, and what `--json` returns, in one shape. */
const describeProcesses = async (env: EnvWithRelations) => {
  const processes = await new ProcessService(prisma).getProcesses(env.id);
  return processes
    .map(proc => ({
      app: proc.appName,
      status: proc.status,
      pid: proc.pid,
      port: proc.port,
      url: `http://localhost:${proc.port}`,
    }))
    .sort((a, b) => a.app.localeCompare(b.app));
};

const printProcesses = async (
  env: EnvWithRelations,
  json: boolean,
): Promise<void> => {
  const rows = await describeProcesses(env);
  if (json) {
    printJson({ environment: env.name, processes: rows });
    return;
  }
  if (rows.length === 0) {
    console.log(colors.yellow(`No process recorded for ${env.name}`));
    console.log(
      colors.dim("Start them with:"),
      colors.white(`devflow run ${env.name}`),
    );
    return;
  }
  printTable(
    rows.map(row => [
      colors.bold(row.app),
      row.status === "RUNNING"
        ? colors.green(row.status)
        : row.status === "ERROR"
          ? colors.red(row.status)
          : colors.yellow(row.status),
      row.pid ? String(row.pid) : colors.dim("-"),
      colors.cyan(row.url),
    ]),
    {
      columns: [
        { header: "APP" },
        { header: "STATUS" },
        { header: "PID" },
        { header: "URL" },
      ],
    },
  );
};

export const psCommand = new Command()
  .name("ps")
  .description("List and control an environment's dev server processes")
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow ps                    what is running in this checkout
  $ devflow ps start api          start one app, leaving the others alone
  $ devflow ps restart web        restart one app after a crash
  $ devflow ps stop --all         stop every dev server of this environment`,
  )
  .action(async (envName: string | undefined, options) => {
    try {
      await printProcesses(await resolveEnvironment({ name: envName }), !!options.json);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

psCommand
  .command("start")
  .description("Start one app's dev server")
  .argument("<app>", "App name (e.g. api, web)")
  .option("-e, --env <env-name>", "Environment (default: the one of cwd)")
  .option("--json", "Machine-readable output")
  .action(async (app: string, _flags, command) => {
    const options = commandOptions<{ env?: string; json?: boolean }>(command);
    try {
      const env = await resolveEnvironment({ name: options.env });
      if (env.kind === "LITE") {
        throw new DevflowError(
          "ENVIRONMENT_NOT_RUNNING",
          `${env.name} has no ports or database yet; run \`devflow run ${env.name}\` once to provision it.`,
        );
      }
      const context = appRunContext(env, app);

      const spinner = startSpinner(`Starting ${app}…`, options.json);
      const processes = new ProcessService(prisma);
      await processes.startProcess(
        env.id,
        env.worktreePath,
        app,
        context.port,
        context.databaseUrl,
        context.dbEnvVarName,
        context.devCommand,
      );

      // The proxy forwards the app's original port to this one, the same way
      // a full `devflow run` does; without it a single-app restart silently
      // drops off :3000.
      if (context.originalPort && context.originalPort !== context.port) {
        await new ProxyService()
          .startProxy(env.id, app, context.originalPort, context.port)
          .catch(() => undefined);
      }

      spinner.succeed(colors.green(`${app} started on :${context.port}`));
      await printProcesses(env, !!options.json);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

psCommand
  .command("stop")
  .description("Stop one app's dev server, or all of them with --all")
  .argument("[app]", "App name (omit with --all)")
  .option("-e, --env <env-name>", "Environment (default: the one of cwd)")
  .option("--all", "Stop every dev server of the environment")
  .option("--json", "Machine-readable output")
  .action(async (app: string | undefined, _flags, command) => {
    const options = commandOptions<{
      env?: string;
      all?: boolean;
      json?: boolean;
    }>(command);
    try {
      const env = await resolveEnvironment({ name: options.env });
      if (!app && !options.all) {
        throw new DevflowError(
          "INPUT_REQUIRED",
          "Name an app to stop, or pass --all to stop every dev server.",
        );
      }

      const processes = new ProcessService(prisma);
      const proxies = new ProxyService();
      const spinner = startSpinner(
        options.all ? "Stopping dev servers…" : `Stopping ${app}…`,
        options.json,
      );

      if (options.all) {
        await processes.stopProcesses(env.id);
        await proxies.stopAllProxiesForEnv(env.id);
        spinner.succeed(colors.green(`${env.name} dev servers stopped`));
      } else {
        await processes.stopProcess(env.id, app!);
        await proxies.stopProxyForApp(env.id, app!);
        spinner.succeed(colors.green(`${app} stopped`));
      }

      await printProcesses(env, !!options.json);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

psCommand
  .command("restart")
  .description("Restart one app's dev server")
  .argument("<app>", "App name (e.g. api, web)")
  .option("-e, --env <env-name>", "Environment (default: the one of cwd)")
  .option("--json", "Machine-readable output")
  .action(async (app: string, _flags, command) => {
    const options = commandOptions<{ env?: string; json?: boolean }>(command);
    try {
      const env = await resolveEnvironment({ name: options.env });
      const context = appRunContext(env, app);

      const spinner = startSpinner(`Restarting ${app}…`, options.json);
      await new ProcessService(prisma).restartProcess(
        env.id,
        env.worktreePath,
        app,
        context.port,
        context.databaseUrl,
        context.dbEnvVarName,
        context.devCommand,
      );
      spinner.succeed(colors.green(`${app} restarted on :${context.port}`));

      await printProcesses(env, !!options.json);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow ps stop-all`: stop the dev servers of every environment.
 *
 * Deliberately scoped to what DevFlow started and recorded, environment by
 * environment. The desktop app also had a machine-wide panic button that
 * SIGKILLed every node process on the host — that is not something a CLI
 * should offer, because on this machine "every node process" includes the
 * coding agents driving it. `devflow kill-zombies` covers the real need
 * (orphaned dev servers) without that blast radius.
 */
psCommand
  .command("stop-all")
  .description("Stop the dev servers of every environment")
  .option("--json", "Machine-readable output")
  .action(async (_flags, command) => {
    const options = commandOptions<{ json?: boolean }>(command);
    try {
      const environments = await prisma.environment.findMany({
        select: { id: true, name: true },
      });
      const processes = new ProcessService(prisma);
      const proxies = new ProxyService();

      const stopped: string[] = [];
      for (const env of environments) {
        const running = (await processes.getProcesses(env.id)).filter(
          proc => proc.status === "RUNNING",
        );
        if (running.length === 0) continue;
        await processes.stopProcesses(env.id);
        await proxies.stopAllProxiesForEnv(env.id);
        stopped.push(env.name);
      }

      if (options.json) {
        printJson({ stopped });
        return;
      }
      console.log(
        stopped.length === 0
          ? colors.green("No dev server was running")
          : colors.green(`Stopped the dev servers of: ${stopped.join(", ")}`),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
