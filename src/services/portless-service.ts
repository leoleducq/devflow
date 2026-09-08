import { execa } from "execa";

/**
 * DevFlow's side of portless, which puts stable named HTTPS URLs in front of
 * the localhost ports an environment runs on.
 *
 * DevFlow already allocates a free port per app; portless only needs to be
 * told about it. `portless alias <name> <port>` registers an already-running
 * server, so nothing is launched through portless and the dev servers stay
 * exactly as `devflow run` starts them — the alias is a route, added after
 * the fact and removed on teardown.
 *
 * Every call is best-effort at the call sites. portless is opt-in per project
 * and needs Node 24; it not being installed, or its proxy being down, must
 * never fail provisioning, teardown or `env-files`. When it cannot be used
 * the environment simply keeps its plain `localhost:<port>` URLs.
 */

export type PortlessStatus = {
  installed: boolean;
  /** Proxy answering, so the registered hostnames actually resolve. */
  running: boolean;
  version?: string;
  /**
   * Port the proxy listens on. 443 means the URLs carry no port; anything
   * else is the high port it fell back to without sudo, and every URL has to
   * carry it.
   */
  proxyPort?: number;
  /** Why portless is unusable, when it is. */
  reason?: string;
};

export type PortlessRoute = {
  hostname: string;
  url: string;
  port: number;
};

/** portless needs Node 24; below that its CLI refuses to run at all. */
const MIN_NODE_MAJOR = 24;

/**
 * One DNS label of a portless hostname: lowercase alphanumerics and dashes,
 * never leading or trailing with one. A label that slugifies to nothing, or
 * starts with a digit, gets a letter in front so the hostname stays a legal
 * one.
 */
export const toHostLabel = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug && /^[a-z]/.test(slug) ? slug : `d${slug}`;
};

/**
 * The alias name for one app of one environment: `<app>.<env>.<project>`.
 *
 * Read right to left it goes from the widest scope to the narrowest, the way
 * a domain does, so every environment of a project shares a suffix and the
 * apps of one environment share two. It is derived purely from names DevFlow
 * already stores, which is what keeps it stable: re-provisioning the same
 * branch rebuilds the same hostname, so the URLs a developer bookmarked and
 * the ones written into `.env` files do not churn.
 */
export const aliasName = (
  app: string,
  environment: string,
  project: string,
): string =>
  [app, environment, project].map(toHostLabel).join(".");

/**
 * The address to show for one app: its portless URL when the project opted in
 * and portless is actually serving that hostname, else the plain localhost
 * port. Callers pass the routes they already fetched, so a table of many
 * environments costs one `portless list` rather than one call per app.
 */
export const appUrl = (params: {
  app: string;
  port: number;
  environment: string;
  project: { name: string; portless: boolean } | null;
  routes: PortlessRoute[];
}): string => {
  const { app, port, environment, project, routes } = params;
  if (!project?.portless) return `http://localhost:${port}`;
  const hostname = `${aliasName(app, environment, project.name)}.localhost`;
  const route = routes.find(r => r.hostname === hostname);
  return route ? route.url : `http://localhost:${port}`;
};

export class PortlessService {
  /**
   * Whether portless can be used at all, and how. Never throws: the answer
   * "no, because …" is the useful one for `doctor` and for the warnings the
   * lifecycle prints.
   */
  async status(): Promise<PortlessStatus> {
    let version: string | undefined;
    try {
      const { stdout } = await execa("portless", ["--version"]);
      version = stdout.trim().replace(/^portless\s+/, "");
    } catch {
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      return {
        installed: false,
        running: false,
        reason:
          nodeMajor < MIN_NODE_MAJOR
            ? `not on PATH; portless needs Node ${MIN_NODE_MAJOR}+ and this is Node ${process.versions.node}`
            : "not on PATH",
      };
    }

    // `doctor` is the only command that reports the proxy: it prints the
    // target it would route through and whether anything is listening there.
    try {
      const { stdout } = await execa("portless", ["doctor"], {
        reject: false,
      });
      const proxyPort = this.parseProxyPort(stdout);
      const running = !/Proxy is not running/i.test(stdout);
      return {
        installed: true,
        running,
        version,
        proxyPort,
        reason: running ? undefined : "proxy is not running",
      };
    } catch {
      return {
        installed: true,
        running: false,
        version,
        reason: "portless doctor failed",
      };
    }
  }

  /**
   * Point `name` at an already-listening local port. `--force` because
   * re-provisioning an environment reuses the hostname on a freshly
   * allocated port, and a stale route would otherwise win.
   */
  async registerAlias(name: string, port: number): Promise<void> {
    await execa("portless", ["alias", name, String(port), "--force"]);
  }

  async removeAlias(name: string): Promise<void> {
    await execa("portless", ["alias", "--remove", name]);
  }

  /**
   * The URL portless serves `name` on, asked of portless rather than built
   * here: only it knows whether the proxy got :443 or fell back to a high
   * port that every URL then has to carry.
   */
  async urlFor(name: string): Promise<string | null> {
    try {
      const { stdout } = await execa("portless", ["get", name]);
      const url = stdout.trim();
      return url.startsWith("http") ? url : null;
    } catch {
      return null;
    }
  }

  /** Every route portless currently serves. */
  async listRoutes(): Promise<PortlessRoute[]> {
    const { stdout } = await execa("portless", ["list"]);
    const routes: PortlessRoute[] = [];
    for (const line of stdout.split("\n")) {
      // "  https://web.env.proj.localhost:1355  ->  localhost:61234  (alias)"
      const match = line.match(
        /(https?:\/\/(\S+?)(?::\d+)?)\s+->\s+\S*?:(\d+)/,
      );
      if (!match?.[1] || !match[2] || !match[3]) continue;
      routes.push({
        url: match[1],
        hostname: match[2],
        port: Number(match[3]),
      });
    }
    return routes;
  }

  /**
   * Register one alias per app and return the URL each got, keyed by app.
   *
   * Best-effort as a whole and per app: an environment is not broken because
   * a route could not be added, so a failure drops that app from the result
   * and the caller falls back to its plain port.
   */
  async registerEnvironment(params: {
    environment: string;
    project: string;
    ports: Record<string, number>;
  }): Promise<Record<string, string>> {
    const urls: Record<string, string> = {};
    for (const [app, port] of Object.entries(params.ports)) {
      const name = aliasName(app, params.environment, params.project);
      try {
        await this.registerAlias(name, port);
        const url = await this.urlFor(name);
        if (url) urls[app] = url;
      } catch {
        // Leave this app on its plain port.
      }
    }
    return urls;
  }

  /** Drop every alias an environment owns. Absent routes are not an error. */
  async removeEnvironment(params: {
    environment: string;
    project: string;
    apps: string[];
  }): Promise<void> {
    for (const app of params.apps) {
      await this
        .removeAlias(aliasName(app, params.environment, params.project))
        .catch(() => undefined);
    }
  }

  /** "Proxy target: https://127.0.0.1:1355" → 1355. */
  private parseProxyPort(doctorOutput: string): number | undefined {
    const match = doctorOutput.match(/Proxy target:\s*https?:\/\/\S+?:(\d+)/);
    return match?.[1] ? Number(match[1]) : undefined;
  }
}
