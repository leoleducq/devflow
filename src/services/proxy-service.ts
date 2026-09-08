import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

type PortProxy = {
  envId: string;
  appName: string;
  originalPort: number;
  targetPort: number;
  server: Server;
};

export class ProxyService {
  private proxies = new Map<number, PortProxy>();

  async startProxy(
    envId: string,
    appName: string,
    originalPort: number,
    targetPort: number,
  ): Promise<void> {
    if (this.proxies.has(originalPort)) {
      const existing = this.proxies.get(originalPort)!;
      if (existing.envId === envId && existing.appName === appName) {
        return;
      }
      await this.stopProxyOnPort(originalPort);
    }

    const server = createServer((req, res) => {
      this.proxyRequest(req, res, targetPort);
    });

    // Without this, an upgrade request gets no response at all and the socket
    // just hangs. That silently breaks any dev server whose client opens a
    // WebSocket during startup — Next's HMR client blocks hydration on it, so
    // the page renders but React never comes alive.
    server.on("upgrade", (req, socket, head) => {
      this.proxyUpgrade(req, socket, head, targetPort);
    });

    await new Promise<void>((resolve, reject) => {
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${originalPort} is already in use. Cannot start proxy for ${appName}.`,
            ),
          );
        } else {
          reject(err);
        }
      });
      server.listen(originalPort, () => resolve());
    });

    this.proxies.set(originalPort, {
      envId,
      appName,
      originalPort,
      targetPort,
      server,
    });
  }

  async stopProxyOnPort(port: number): Promise<void> {
    const proxy = this.proxies.get(port);
    if (!proxy) return;

    this.proxies.delete(port);

    // Force-close all active connections so server.close() resolves
    // immediately instead of waiting for long-lived connections (WebSockets,
    // SSE streams, dev-server HMR) to drain.
    proxy.server.closeAllConnections?.();

    await new Promise<void>(resolve => {
      // Don't reject on ERR_SERVER_NOT_RUNNING — server may already be closing
      proxy.server.close(() => resolve());
    });
  }

  async stopProxyForApp(envId: string, appName: string): Promise<void> {
    const match = Array.from(this.proxies.entries()).find(
      ([, p]) => p.envId === envId && p.appName === appName,
    );
    if (match) await this.stopProxyOnPort(match[0]);
  }

  async stopAllProxiesForEnv(envId: string): Promise<void> {
    const toStop = Array.from(this.proxies.entries()).filter(
      ([, p]) => p.envId === envId,
    );
    await Promise.all(toStop.map(([port]) => this.stopProxyOnPort(port)));
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.proxies.keys()).map(port => this.stopProxyOnPort(port)),
    );
  }

  getProxiesForEnv(envId: string): PortProxy[] {
    return Array.from(this.proxies.values()).filter(p => p.envId === envId);
  }

  isPortProxied(port: number): boolean {
    return this.proxies.has(port);
  }

  getActiveEnvId(): string | null {
    const first = this.proxies.values().next();
    if (first.done) return null;
    return first.value.envId;
  }

  private proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetPort: number,
  ): void {
    const proxyReq = httpRequest(
      {
        hostname: "localhost",
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      proxyRes => {
        res.writeHead(
          proxyRes.statusCode ?? 502,
          groupRawHeaders(proxyRes.rawHeaders),
        );
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Bad Gateway",
          message: `Target service on port ${targetPort} unavailable`,
        }),
      );
    });

    req.pipe(proxyReq);
  }

  /**
   * Relay a protocol upgrade (WebSocket) to the target, then splice the two
   * sockets together so frames flow both ways untouched.
   */
  private proxyUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    targetPort: number,
  ): void {
    const proxyReq = httpRequest({
      hostname: "localhost",
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      const headerLines = pairRawHeaders(proxyRes.rawHeaders)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      socket.write(`${statusLine}${headerLines}\r\n`);

      if (proxyHead?.length) proxySocket.unshift(proxyHead);
      // Frames already buffered by the client must reach the target, or the
      // handshake completes and the first message is lost.
      if (head?.length) socket.unshift(head);

      const drop = () => {
        proxySocket.destroy();
        socket.destroy();
      };
      proxySocket.on("error", drop);
      socket.on("error", drop);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    // The target may answer an upgrade with a normal response (e.g. 404).
    // Forward it verbatim rather than leaving the client waiting.
    proxyReq.on("response", proxyRes => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      const headerLines = pairRawHeaders(proxyRes.rawHeaders)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      socket.write(`${statusLine}${headerLines}\r\n`);
      proxyRes.pipe(socket);
    });

    proxyReq.on("error", () => socket.destroy());
    socket.on("error", () => proxyReq.destroy());

    if (head?.length) proxyReq.write(head);
    proxyReq.end();
  }
}

/** Raw header list (`[name, value, name, value, …]`) as ordered pairs. */
function pairRawHeaders(raw: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([raw[i]!, raw[i + 1]!]);
  }
  return pairs;
}

/**
 * Headers for `writeHead`, keeping repeated fields separate.
 *
 * `IncomingMessage.headers` is a plain object, so two `link` headers collapse
 * into one comma-joined string — which also corrupts `set-cookie`, `vary` and
 * `www-authenticate`. Grouping repeats into arrays preserves them on the wire.
 */
function groupRawHeaders(raw: string[]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of pairRawHeaders(raw)) {
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[key] = [existing, value];
    }
  }
  return headers;
}
