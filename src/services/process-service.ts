import { join } from "node:path";
import { readFile, appendFile, mkdir, stat, rm } from "node:fs/promises";
import { execa, type ResultPromise } from "execa";
import type { PrismaClient } from "../db/types.js";
import { devflowHome } from "../db/paths.js";
import {
  resolvePackageManager,
  execBinaryArgv,
} from "../lib/package-manager.js";

type RunningProcess = {
  id: string;
  process: ResultPromise;
};

export type LogEntry = {
  timestamp: number;
  app: string;
  stream: "stdout" | "stderr";
  text: string;
};

type LogSubscriber = (entry: LogEntry) => void;

const MAX_LOG_LINES = 1000;

/**
 * Dev-server output also goes to a file per environment, not just the
 * in-memory ring buffer.
 *
 * The desktop API could serve `/logs` from memory because it was one
 * long-lived server. A CLI is not: the process that started the servers
 * (`devflow run`, sitting in a herdr pane) is a different process from the
 * one asking for the logs (`devflow logs`, run by an agent in another pane).
 * The only thing the two share is the filesystem.
 */
const LOG_DIR = () => join(devflowHome(), "logs");
export const environmentLogFile = (environmentId: string): string =>
  join(LOG_DIR(), `${environmentId}.jsonl`);

/** Rotate at this size so a week of `next dev` cannot fill the disk. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type ZombieProcess = { pid: number; command: string };

/** What a dev server looks like in `ps`. */
const DEV_SERVER_PATTERN =
  /next-server|next dev|turbo run dev|turbo dev|tsx watch|vite(?:\s|$)|nodemon|ts-node-dev/;
/** A `devflow run` that owns its dev servers; its children are not zombies. */
const RUNNER_PATTERN = /devflow(?:\.js)? run\b|src\/index\.ts run\b/;
/** Ports of a DevFlow desktop API whose child dev servers are legitimate. */
const OWNER_PORTS = [9005, 19005];
/** Never touch these even if they match a dev-server word. */
const PROTECTED_PATTERN =
  /devflow(?:\.js)? proxy|index\.ts proxy|claude|pi-coding-agent|codex|herdr/;

export class ProcessService {
  private runningProcesses = new Map<string, RunningProcess[]>();
  private logBuffers = new Map<string, LogEntry[]>();
  private logSubscribers = new Map<string, Set<LogSubscriber>>();

  constructor(private readonly prisma: PrismaClient) {}

  getLogs(environmentId: string): LogEntry[] {
    return this.logBuffers.get(environmentId) ?? [];
  }

  subscribeLogs(environmentId: string, callback: LogSubscriber): () => void {
    let subs = this.logSubscribers.get(environmentId);
    if (!subs) {
      subs = new Set();
      this.logSubscribers.set(environmentId, subs);
    }
    subs.add(callback);
    return () => {
      subs.delete(callback);
      if (subs.size === 0) this.logSubscribers.delete(environmentId);
    };
  }

  private pushLog(environmentId: string, entry: LogEntry) {
    let buffer = this.logBuffers.get(environmentId);
    if (!buffer) {
      buffer = [];
      this.logBuffers.set(environmentId, buffer);
    }
    buffer.push(entry);
    if (buffer.length > MAX_LOG_LINES) {
      buffer.splice(0, buffer.length - MAX_LOG_LINES);
    }
    const subs = this.logSubscribers.get(environmentId);
    if (subs) {
      for (const cb of subs) cb(entry);
    }
    // Fire and forget: a dev server must never block on DevFlow's logging,
    // and a log line lost to a full disk is not worth failing a run over.
    void this.appendToLogFile(environmentId, entry);
  }

  /**
   * Append one entry to the environment's log file, rotating when it grows
   * past the cap. Writes are serialised per environment so two apps' output
   * cannot interleave inside a single line.
   */
  private logWrites = new Map<string, Promise<void>>();

  private appendToLogFile(environmentId: string, entry: LogEntry): void {
    const previous = this.logWrites.get(environmentId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const file = environmentLogFile(environmentId);
        await mkdir(LOG_DIR(), { recursive: true });
        const size = await stat(file).then(
          s => s.size,
          () => 0,
        );
        // Truncating rather than keeping a `.1` file: these are dev-server
        // logs, and nobody goes back eight megabytes for them.
        if (size > MAX_LOG_BYTES) await rm(file, { force: true });
        await appendFile(file, `${JSON.stringify(entry)}\n`);
      })
      .catch(() => undefined);
    this.logWrites.set(environmentId, next);
  }

  /**
   * The environment's persisted log, newest last. This is what another
   * process — `devflow logs` — reads, since it cannot see the ring buffer of
   * the `devflow run` that produced the output.
   */
  async readLogFile(
    environmentId: string,
    options: { app?: string; stream?: "stdout" | "stderr"; limit?: number } = {},
  ): Promise<LogEntry[]> {
    const content = await readFile(environmentLogFile(environmentId), "utf-8").catch(
      () => "",
    );
    if (!content) return [];

    const entries: LogEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        if (options.app && entry.app !== options.app) continue;
        if (options.stream && entry.stream !== options.stream) continue;
        entries.push(entry);
      } catch {
        // A half-written last line while a server is running: skip it.
      }
    }
    return options.limit ? entries.slice(-options.limit) : entries;
  }


  async startProcesses(
    environmentId: string,
    worktreePath: string,
    apps: string[],
    ports: Record<string, number>,
    databaseUrl: string,
    dbEnvVarName: string = "DATABASE_URL",
    devCommands: Record<string, string> = {},
    packageManager?: string | null,
  ): Promise<void> {
    const processes: RunningProcess[] = [];

    for (const app of apps) {
      const port = ports[app];
      if (!port) continue;

      const handle = await this.spawnAppProcess(
        environmentId,
        worktreePath,
        app,
        port,
        databaseUrl,
        dbEnvVarName,
        devCommands[app],
        packageManager,
      );
      if (handle) processes.push(handle);
    }

    this.runningProcesses.set(environmentId, processes);
  }

  /**
   * Start a single app's dev process and append it to the environment's
   * running-process list. Used by both `startProcesses` (bulk) and
   * `startProcess` (single-app control).
   */
  async startProcess(
    environmentId: string,
    worktreePath: string,
    app: string,
    port: number,
    databaseUrl: string,
    dbEnvVarName: string = "DATABASE_URL",
    devCommand?: string,
    packageManager?: string | null,
  ): Promise<void> {
    const handle = await this.spawnAppProcess(
      environmentId,
      worktreePath,
      app,
      port,
      databaseUrl,
      dbEnvVarName,
      devCommand,
      packageManager,
    );
    if (!handle) return;

    const existing = this.runningProcesses.get(environmentId) ?? [];
    // Drop any stale handle for the same app before appending the new one.
    const filtered = existing.filter(p => p.id !== handle.id);
    filtered.push(handle);
    this.runningProcesses.set(environmentId, filtered);
  }

  /**
   * Spawn one app's dev process, wire up logs and DB tracking, and return its
   * running handle. Returns null when the spawn failed (status persisted as
   * ERROR). Single responsibility: launch + track one app.
   */
  private async spawnAppProcess(
    environmentId: string,
    worktreePath: string,
    app: string,
    port: number,
    databaseUrl: string,
    dbEnvVarName: string,
    devCommand?: string,
    packageManager?: string | null,
  ): Promise<RunningProcess | null> {
    try {
      // Kill any existing process on this port before starting
      await this.killProcessOnPort(port);

      const parentEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("NEXT_PUBLIC_") &&
            key !== "PORT" &&
            key !== "DATABASE_URL",
        ),
      );

      // When launched from Finder/Tauri, PATH may be minimal and miss the
      // package manager, node or git. Augment it with common install paths.
      const home = process.env.HOME || "";
      const extraPaths = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${home}/.local/bin`,
        `${home}/Library/pnpm`,
        `${home}/.bun/bin`,
        `${home}/.yarn/bin`,
      ];
      const currentPath = parentEnv.PATH || "";
      const pathParts = currentPath.split(":").filter(Boolean);
      for (const p of extraPaths) {
        if (!pathParts.includes(p)) pathParts.push(p);
      }
      parentEnv.PATH = pathParts.join(":");
      // Read the app's .env file and re-inject all vars to override any leaking parent env
      const dotEnvVars = await this.parseDotEnv(
        join(worktreePath, "apps", app, ".env"),
      );

      const envVars = {
        ...parentEnv,
        ...dotEnvVars,
        PORT: String(port),
        [`${app.toUpperCase()}_PORT`]: String(port),
        [dbEnvVarName]: databaseUrl,
      };

      const manager = await resolvePackageManager(worktreePath, packageManager);

      // A project-configured dev command names a binary from the app's own
      // dependencies (`next dev`, `tsx watch src`); without one, turbo drives
      // the app's `dev` script from the repo root.
      const [argv, cwd] = devCommand
        ? [
            ((): { command: string; args: string[] } => {
              const [binary, ...rest] = devCommand.split(/\s+/).filter(Boolean);
              return execBinaryArgv(manager, binary ?? "", rest);
            })(),
            join(worktreePath, "apps", app),
          ]
        : [
            execBinaryArgv(manager, "turbo", ["run", "dev", "--filter", app]),
            worktreePath,
          ];

      const childProcess: ResultPromise = execa(argv.command, argv.args, {
        cwd,
        env: envVars,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      childProcess.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(`[${app}] ${text}`);
        this.pushLog(environmentId, {
          timestamp: Date.now(),
          app,
          stream: "stdout",
          text,
        });
      });
      childProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        process.stderr.write(`[${app}] ${text}`);
        this.pushLog(environmentId, {
          timestamp: Date.now(),
          app,
          stream: "stderr",
          text,
        });
      });

      const processRecord = await this.prisma.processInfo.upsert({
        where: {
          environmentId_appName: { environmentId, appName: app },
        },
        update: {
          pid: childProcess.pid ?? null,
          status: "RUNNING",
          port,
        },
        create: {
          environmentId,
          appName: app,
          pid: childProcess.pid ?? null,
          status: "RUNNING",
          port,
        },
      });

      // Handle process exit
      childProcess.catch(async (error: { stderr?: string }) => {
        console.error(
          `[process-service] ${app} exited with error:`,
          error.stderr ?? "unknown",
        );
        await this.prisma.processInfo
          .update({
            where: { id: processRecord.id },
            data: { status: "ERROR" },
          })
          .catch(() => {});
      });

      return { id: processRecord.id, process: childProcess };
    } catch {
      await this.prisma.processInfo.upsert({
        where: {
          environmentId_appName: { environmentId, appName: app },
        },
        update: {
          status: "ERROR",
          port,
        },
        create: {
          environmentId,
          appName: app,
          status: "ERROR",
          port,
        },
      });
      return null;
    }
  }

  async stopProcesses(environmentId: string): Promise<void> {
    const handles = this.runningProcesses.get(environmentId);
    if (handles) {
      for (const proc of handles) {
        try {
          // Kill the entire process group to ensure child processes die too
          if (proc.process.pid) {
            process.kill(-proc.process.pid, "SIGTERM");
          }
          await proc.process.catch(() => {});
        } catch {
          // Process might already be dead
        }
      }
      this.runningProcesses.delete(environmentId);
    }

    // Fallback: kill by PID for orphaned processes (e.g. after API restart)
    // Kill the entire process group (-pid) to ensure child processes are also killed
    const dbProcesses = await this.prisma.processInfo.findMany({
      where: { environmentId, status: "RUNNING" },
    });
    for (const proc of dbProcesses) {
      if (proc.pid) {
        try {
          // Kill the process group to catch child processes (e.g. next-server spawned by pnpm)
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          try {
            // Fallback: kill just the process
            process.kill(proc.pid, "SIGTERM");
          } catch {
            // Already dead
          }
        }
      }
    }

    // Final fallback: kill by port to catch any remaining processes
    for (const proc of dbProcesses) {
      if (proc.port) {
        await this.killProcessOnPort(proc.port);
      }
    }

    await this.prisma.processInfo.updateMany({
      where: { environmentId },
      data: { status: "STOPPED" },
    });
  }

  /**
   * Stop a single app's dev process within an environment, leaving the others
   * running. Mirrors `stopProcesses` kill logic (process group SIGTERM,
   * PID/port fallbacks) but scoped to one app.
   */
  async stopProcess(environmentId: string, appName: string): Promise<void> {
    const handles = this.runningProcesses.get(environmentId);
    const record = await this.prisma.processInfo.findUnique({
      where: { environmentId_appName: { environmentId, appName } },
    });

    if (handles) {
      const handle = record ? handles.find(p => p.id === record.id) : undefined;
      if (handle) {
        try {
          // Kill the entire process group to ensure child processes die too
          if (handle.process.pid) {
            process.kill(-handle.process.pid, "SIGTERM");
          }
          await handle.process.catch(() => {});
        } catch {
          // Process might already be dead
        }
      }
      this.runningProcesses.set(
        environmentId,
        record ? handles.filter(p => p.id !== record.id) : handles,
      );
    }

    // Fallback: kill by PID for orphaned processes (e.g. after API restart)
    if (record?.pid) {
      try {
        // Kill the process group to catch child processes (e.g. next-server)
        process.kill(-record.pid, "SIGTERM");
      } catch {
        try {
          process.kill(record.pid, "SIGTERM");
        } catch {
          // Already dead
        }
      }
    }

    // Final fallback: kill by port to catch any remaining processes
    if (record?.port) {
      await this.killProcessOnPort(record.port);
    }

    await this.prisma.processInfo.updateMany({
      where: { environmentId, appName },
      data: { status: "STOPPED" },
    });
  }

  /**
   * Restart a single app: stop it, then start it again on the same port.
   */
  async restartProcess(
    environmentId: string,
    worktreePath: string,
    app: string,
    port: number,
    databaseUrl: string,
    dbEnvVarName: string = "DATABASE_URL",
    devCommand?: string,
    packageManager?: string | null,
  ): Promise<void> {
    await this.stopProcess(environmentId, app);
    await this.startProcess(
      environmentId,
      worktreePath,
      app,
      port,
      databaseUrl,
      dbEnvVarName,
      devCommand,
      packageManager,
    );
  }

  async getProcesses(environmentId: string) {
    const processes = await this.prisma.processInfo.findMany({
      where: { environmentId },
    });

    const staleIds: string[] = [];
    for (const proc of processes) {
      if (proc.status === "RUNNING" && proc.pid) {
        try {
          process.kill(proc.pid, 0);
        } catch {
          staleIds.push(proc.id);
          proc.status = "STOPPED";
        }
      }
    }

    if (staleIds.length > 0) {
      await this.prisma.processInfo.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "STOPPED" },
      });
    }

    return processes;
  }

  private async parseDotEnv(filePath: string): Promise<Record<string, string>> {
    try {
      const content = await readFile(filePath, "utf-8");
      const vars: Record<string, string> = {};
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        // Remove surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        vars[key] = value;
      }
      return vars;
    } catch {
      return {};
    }
  }

  private async killProcessOnPort(port: number): Promise<boolean> {
    try {
      const { stdout } = await execa("lsof", ["-ti", `:${port}`]);
      const pids = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
        .filter(pid => pid > 0 && pid !== process.pid);

      if (pids.length === 0) return false;

      // First pass: SIGTERM on process groups and individual processes
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already dead
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      // Second pass: SIGKILL anything still alive
      for (const pid of pids) {
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already dead
          }
        }
      }

      return true;
    } catch {
      // lsof returns non-zero when no process found
      return false;
    }
  }

  async stopAll(): Promise<void> {
    const envIds = Array.from(this.runningProcesses.keys());
    await Promise.all(envIds.map(id => this.stopProcesses(id)));
  }

  async cleanupStaleProcesses(): Promise<void> {
    await this.prisma.processInfo.updateMany({
      where: { status: "RUNNING" },
      data: { status: "STOPPED" },
    });
  }

  private async getAncestorPids(pid: number): Promise<number[]> {
    const ancestors: number[] = [];
    let current = pid;
    for (let i = 0; i < 10; i++) {
      try {
        const { stdout } = await execa("ps", [
          "-o",
          "ppid=",
          "-p",
          String(current),
        ]);
        const ppid = Number(stdout.trim());
        if (ppid <= 1) break;
        ancestors.push(ppid);
        current = ppid;
      } catch {
        break;
      }
    }
    return ancestors;
  }

  /**
   * Dev-server processes nobody is looking after: next/turbo/tsx/vite that
   * no live `devflow run` owns. Under herdr, agents (Claude, pi) and the
   * proxy are node processes too, so this is deliberately narrower than
   * killAllProcesses.
   */
  async findZombies(): Promise<ZombieProcess[]> {
    const { stdout } = await execa("ps", ["-axo", "pid=,ppid=,command="]);
    const table = new Map<number, { ppid: number; command: string }>();
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (match) {
        table.set(Number(match[1]), {
          ppid: Number(match[2]),
          command: match[3] ?? "",
        });
      }
    }

    // The desktop app's API (still around "just in case") owns the dev
    // servers it started; they are not zombies while it is up.
    const ownerPids = new Set<number>();
    for (const port of OWNER_PORTS) {
      try {
        const { stdout } = await execa("lsof", ["-ti", `:${port}`]);
        for (const pid of stdout.split("\n").map(Number)) {
          if (pid > 0) ownerPids.add(pid);
        }
      } catch {
        // Nothing on that port.
      }
    }

    const hasLiveOwner = (pid: number): boolean => {
      let current = table.get(pid)?.ppid ?? 0;
      for (let i = 0; i < 12 && current > 1; i++) {
        const entry = table.get(current);
        if (!entry) break;
        if (ownerPids.has(current) || RUNNER_PATTERN.test(entry.command))
          return true;
        current = entry.ppid;
      }
      return false;
    };

    const zombies: ZombieProcess[] = [];
    for (const [pid, { command }] of table) {
      if (pid === process.pid) continue;
      if (!DEV_SERVER_PATTERN.test(command)) continue;
      if (PROTECTED_PATTERN.test(command)) continue;
      if (hasLiveOwner(pid)) continue;
      zombies.push({ pid, command: command.slice(0, 120) });
    }
    return zombies;
  }

  /** Kill what findZombies reports; SIGTERM first, SIGKILL for the stubborn. */
  async killZombies(): Promise<ZombieProcess[]> {
    const zombies = await this.findZombies();
    for (const { pid } of zombies) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await new Promise(r => setTimeout(r, 1500));
    for (const { pid } of zombies) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited on SIGTERM.
      }
    }
    return zombies;
  }

  async killAllProcesses(): Promise<{ killed: number }> {
    const protectedPorts = [9000, 9005];
    let killed = 0;

    // Find PIDs on protected ports + all their ancestor PIDs
    const protectedPids = new Set<number>([process.pid]);
    for (const port of protectedPorts) {
      try {
        const { stdout } = await execa("lsof", ["-ti", `:${port}`]);
        for (const pid of stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number)) {
          if (pid > 0) {
            protectedPids.add(pid);
            const ancestors = await this.getAncestorPids(pid);
            for (const a of ancestors) protectedPids.add(a);
          }
        }
      } catch {
        // No process on this port
      }
    }

    // Also protect our own ancestors (tsx watch -> turbo -> pnpm)
    const ownAncestors = await this.getAncestorPids(process.pid);
    for (const a of ownAncestors) protectedPids.add(a);

    // Kill ALL node processes except protected ones
    try {
      const { stdout } = await execa("pgrep", ["-f", "node"]);
      const allNodePids = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
        .filter(pid => pid > 0 && !protectedPids.has(pid));

      for (const pid of allNodePids) {
        try {
          process.kill(pid, "SIGKILL");
          killed++;
        } catch {
          // Already dead
        }
      }
    } catch {
      // No node processes found
    }

    this.runningProcesses.clear();

    await this.prisma.processInfo.updateMany({
      where: { status: "RUNNING" },
      data: { status: "STOPPED" },
    });

    return { killed };
  }
}
