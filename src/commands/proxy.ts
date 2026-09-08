import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma, parseJsonObject } from "../db/index.js";
import { ProxyService } from "../services/index.js";

const POLL_MS = 1000;

/**
 * `devflow proxy`: the one long-running piece. Forwards each project's
 * original ports (web 3000, api 3005, …) to the active environment's dynamic
 * ports, and follows `devflow activate` by watching the config. Run it from
 * launchd so it outlives terminals and herdr.
 */
export const proxyCommand = new Command()
  .name("proxy")
  .description("Forward original app ports to the active environment (daemon)")
  .action(async () => {
    const proxies = new ProxyService();
    let current: string | null = null;

    const log = (line: string) =>
      console.log(`${colors.dim(new Date().toISOString())} ${line}`);

    const apply = async (environmentId: string | null) => {
      await proxies.stopAll();
      current = environmentId;
      if (!environmentId) {
        log("no active environment");
        return;
      }
      const env = await prisma.environment.findUnique({
        where: { id: environmentId },
        include: { ports: true, project: true },
      });
      if (!env || !env.project) {
        log(colors.yellow(`active environment ${environmentId} is gone`));
        return;
      }
      const appPorts =
        parseJsonObject<Record<string, number>>(env.project.appPorts) ?? {};
      const dynamic = new Map(env.ports.map(p => [p.appName, p.port]));
      for (const [app, originalPort] of Object.entries(appPorts)) {
        const target = dynamic.get(app);
        if (!target || target === originalPort) continue;
        try {
          await proxies.startProxy(env.id, app, originalPort, target);
          log(`${colors.bold(env.name)} ${app}: :${originalPort} → :${target}`);
        } catch (error) {
          log(
            colors.yellow(
              `${app}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
    };

    const tick = async () => {
      try {
        const config = await prisma.devflowConfig.findFirst();
        const wanted = config?.activeEnvironmentId ?? null;
        if (wanted !== current) await apply(wanted);
      } catch (error) {
        log(colors.red(error instanceof Error ? error.message : String(error)));
      }
    };

    const stop = async () => {
      await proxies.stopAll();
      await prisma.$disconnect();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    log("devflow proxy started");
    await tick();
    setInterval(tick, POLL_MS);
  });
