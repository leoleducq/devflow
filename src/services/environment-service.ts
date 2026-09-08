import { execa } from "execa";
import { join, dirname } from "node:path";
import { rm } from "node:fs/promises";
import fs from "fs-extra";
import type { PrismaClient, Environment, Project } from "../db/types.js";
import { devflowHome } from "../db/paths.js";
import {
  parseJsonArray,
  toJsonArray,
  parseJsonObject,
} from "../lib/json-serialization.js";
import { WorktreeService } from "./worktree-service.js";
import { DockerDatabaseService } from "./docker-database-service.js";
import { PortService } from "./port-service.js";
import { EnvFileService } from "./env-file-service.js";
import { ConfigService } from "./config-service.js";
import { GitHubService } from "./github-service.js";
import { environmentLogFile } from "./process-service.js";
import { HerdrService } from "./herdr-service.js";

export type EnvironmentKind = "FULL" | "LITE";

type CreateEnvironmentOptions = {
  projectId: string;
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
  apps?: string[];
  seedStrategy?: string;
  /** Dump to restore when seedStrategy is SNAPSHOT. */
  snapshotPath?: string;
  skipInstall?: boolean;
  kind?: EnvironmentKind;
};

// Ordered creation steps, surfaced to the UI as a live checklist.
export const CREATE_ENV_STEPS = [
  { id: "worktree", label: "Provisioning git worktree" },
  { id: "ports", label: "Allocating ports" },
  { id: "database", label: "Spinning up database container" },
  { id: "install", label: "Installing dependencies" },
  { id: "env", label: "Generating .env files" },
  { id: "seed", label: "Seeding database" },
] as const;

export type CreateEnvStepId = (typeof CREATE_ENV_STEPS)[number]["id"];

// Promoting a LITE env replays every creation step except the worktree.
export const PROMOTE_ENV_STEPS = CREATE_ENV_STEPS.filter(
  s => s.id !== "worktree",
);

export type CreateEnvProgress =
  | { type: "step"; id: CreateEnvStepId; status: "start" | "done" | "skip" }
  | { type: "done"; environment: Environment }
  | { type: "error"; message: string };

type OnProgress = (event: CreateEnvProgress) => void;

type AdoptWorktreeOptions = {
  worktreePath: string;
  apps?: string[];
  seedStrategy?: string;
  /** Dump to restore when seedStrategy is SNAPSHOT. */
  snapshotPath?: string;
  skipInstall?: boolean;
  baseBranch?: string;
  /** LITE records the checkout without ports, database or install. */
  kind?: EnvironmentKind;
};

const PROVISION_LOCK = join(devflowHome(), "locks", "provision");
/** A lock older than this belongs to a crashed run and is taken over. */
const PROVISION_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Provisioning is heavy (pnpm install, a Postgres seed): several at once
 * saturate the disk and Docker. Run them one after the other, machine-wide.
 */
async function withProvisionLock<T>(work: () => Promise<T>): Promise<T> {
  await fs.ensureDir(dirname(PROVISION_LOCK));
  for (;;) {
    try {
      await fs.mkdir(PROVISION_LOCK);
      break;
    } catch {
      const age =
        Date.now() -
        (await fs.stat(PROVISION_LOCK).catch(() => null))?.mtimeMs!;
      if (Number.isFinite(age) && age > PROVISION_LOCK_STALE_MS) {
        await fs.remove(PROVISION_LOCK);
        continue;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  try {
    return await work();
  } finally {
    await fs.remove(PROVISION_LOCK).catch(() => undefined);
  }
}

const safeRealpath = async (dir: string): Promise<string> => {
  try {
    return await fs.realpath(dir);
  } catch {
    return dir;
  }
};

/** Main repository a checkout belongs to, whether it is a worktree or not. */
async function gitRepoRoot(checkout: string): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: checkout },
  );
  // `<repo>/.git` for a normal repo; strip the trailing `.git`.
  return safeRealpath(stdout.trim().replace(/\/\.git$/, ""));
}

async function gitCurrentBranch(checkout: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: checkout,
  });
  const branch = stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error(`${checkout} is not on a branch`);
  }
  return branch;
}

const PORT_ORDER = ["web", "api"];
/** web first, then api, then the rest: what you open, then what it calls. */
export const sortedPorts = <T extends { appName: string }>(ports: T[]): T[] =>
  [...ports].sort((a, b) => {
    const ia = PORT_ORDER.indexOf(a.appName),
      ib = PORT_ORDER.indexOf(b.appName);
    return (
      (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) ||
      a.appName.localeCompare(b.appName)
    );
  });

export class EnvironmentService {
  private readonly worktreeService: WorktreeService;
  private readonly dockerService: DockerDatabaseService;
  private readonly portService: PortService;
  private readonly envFileService: EnvFileService;
  private readonly configService: ConfigService;
  private readonly herdrService: HerdrService;

  constructor(private readonly prisma: PrismaClient) {
    this.worktreeService = new WorktreeService();
    this.dockerService = new DockerDatabaseService(prisma);
    this.portService = new PortService(prisma);
    this.envFileService = new EnvFileService();
    this.configService = new ConfigService(prisma);
    this.herdrService = new HerdrService();
  }

  /**
   * Show the environment's status and ports in herdr's sidebar, on the
   * workspace already open on its worktree. Never opens one: herdr decides
   * what is on screen, DevFlow only annotates it. Fire-and-forget: herdr
   * being absent or down is not an environment failure.
   */
  private mirrorToHerdr(env: {
    id: string;
    name: string;
    worktreePath: string;
    status: string;
    kind?: string;
    ports?: { appName: string; port: number }[];
  }): void {
    if (!env.worktreePath) return;
    void (async () => {
      const workspace = await this.herdrService.findWorkspaceAt(
        env.worktreePath,
      );
      if (!workspace) return;
      await this.herdrService.reportWorkspaceMetadata(workspace.id, {
        devflow_status: env.kind === "LITE" ? "lite" : env.status.toLowerCase(),
        devflow_ports: sortedPorts(env.ports ?? [])
          .map(p => `${p.appName}:${p.port}`)
          .join(" "),
      });
    })().catch(() => {
      // Not installed, or the server is down.
    });
  }

  async createEnvironment(
    options: CreateEnvironmentOptions,
    onProgress?: OnProgress,
  ): Promise<Environment> {
    const emit = (event: CreateEnvProgress) => onProgress?.(event);
    const project = await this.prisma.project.findUnique({
      where: { id: options.projectId },
    });

    if (!project) {
      throw new Error(`Project not found: ${options.projectId}`);
    }

    // Resolve branch info from PR if prNumber is provided
    let branch = options.branch;
    let baseBranch = options.baseBranch ?? project.defaultBaseBranch;
    let prTitle: string | null = null;
    let prUrl: string | null = null;
    const prNumber = options.prNumber ?? null;

    if (options.prNumber) {
      const githubService = new GitHubService();
      const prInfo = await githubService.getPullRequest(
        project.path,
        options.prNumber,
      );
      branch = prInfo.headBranch;
      baseBranch = prInfo.baseBranch;
      prTitle = prInfo.title;
      prUrl = prInfo.url;
    }

    if (!branch) {
      throw new Error("Either branch or prNumber must be provided");
    }

    const config = await this.configService.getOrCreateConfig();
    const kind: EnvironmentKind = options.kind === "LITE" ? "LITE" : "FULL";
    const projectApps = parseJsonArray(project.apps);
    const projectDefaultApps = parseJsonArray(project.defaultApps);
    const apps =
      kind === "LITE"
        ? []
        : (options.apps ??
          (projectDefaultApps.length > 0 ? projectDefaultApps : projectApps));
    const envName = `${project.name}-${branch.replace(/\//g, "-")}`;

    // Check if environment already exists
    const existing = await this.prisma.environment.findUnique({
      where: { name: envName },
    });
    if (existing) {
      throw new Error(`Environment '${envName}' already exists`);
    }

    // Create environment record
    const environment = await this.prisma.environment.create({
      data: {
        name: envName,
        projectId: project.id,
        branch,
        baseBranch,
        worktreePath: "",
        status: "CREATING",
        kind,
        apps: toJsonArray(apps),
        prNumber,
        prTitle,
        prUrl,
      },
    });

    try {
      // 1. Create worktree
      emit({ type: "step", id: "worktree", status: "start" });
      const worktreePath = await this.worktreeService.createWorktree(
        project.path,
        branch,
        config.worktreeLocation,
        baseBranch,
      );

      await this.prisma.environment.update({
        where: { id: environment.id },
        data: { worktreePath },
      });
      emit({ type: "step", id: "worktree", status: "done" });

      await this.prepareWorktree(project, worktreePath);

      // 2-6. Ports, database, install, .env, seed.
      // LITE envs run nothing: only the optional install happens.
      if (kind === "LITE") {
        emit({ type: "step", id: "ports", status: "skip" });
        emit({ type: "step", id: "database", status: "skip" });
        if (options.skipInstall) {
          emit({ type: "step", id: "install", status: "skip" });
        } else {
          emit({ type: "step", id: "install", status: "start" });
          await this.installDependencies(worktreePath);
          emit({ type: "step", id: "install", status: "done" });
        }
        emit({ type: "step", id: "env", status: "skip" });
        emit({ type: "step", id: "seed", status: "skip" });
      } else {
        await this.provisionFullResources({
          environmentId: environment.id,
          envName,
          worktreePath,
          project,
          apps,
          seedStrategy: options.seedStrategy,
          snapshotPath: options.snapshotPath,
          skipInstall: options.skipInstall ?? false,
          emit,
        });
      }

      // 7. Update status
      const ready = await this.prisma.environment.update({
        where: { id: environment.id },
        data: { status: "RUNNING" },
        include: {
          database: true,
          ports: true,
          processes: true,
          project: true,
        },
      });
      this.mirrorToHerdr(ready);
      emit({ type: "done", environment: ready });
      return ready;
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      // Auto-cleanup on creation failure
      try {
        await this.destroyEnvironment(environment.id);
      } catch {
        // If destroy also fails, at least mark as error
        await this.prisma.environment.update({
          where: { id: environment.id },
          data: { status: "ERROR" },
        });
      }
      throw error;
    }
  }

  /**
   * Turn an existing checkout into an environment.
   *
   * herdr (or the user) already created the worktree; DevFlow adds what a
   * branch needs to run: ports, a seeded database, `.env` files, deps. The
   * project is found from the checkout's main repository, the branch from
   * git, so the only input is the path.
   */
  async adoptWorktree(
    options: AdoptWorktreeOptions,
    onProgress?: OnProgress,
  ): Promise<Environment> {
    const emit = (event: CreateEnvProgress) => onProgress?.(event);
    const worktreePath = await safeRealpath(options.worktreePath);

    const existing = await this.findByWorktreePath(worktreePath);
    if (existing) {
      // A re-opened worktree gets a fresh herdr workspace: label it again.
      this.mirrorToHerdr(existing);
      return existing;
    }

    const repoRoot = await gitRepoRoot(worktreePath);
    const projects = await this.prisma.project.findMany();
    let project: Project | undefined;
    for (const candidate of projects) {
      if ((await safeRealpath(candidate.path)) === repoRoot) {
        project = candidate;
        break;
      }
    }
    if (!project) {
      throw new Error(
        `No DevFlow project registered for ${repoRoot}. Add it with: devflow project add`,
      );
    }

    const branch = await gitCurrentBranch(worktreePath);
    const envName = `${project.name}-${branch.replace(/\//g, "-")}`;
    if (
      await this.prisma.environment.findUnique({ where: { name: envName } })
    ) {
      throw new Error(`Environment '${envName}' already exists`);
    }

    const projectApps = parseJsonArray(project.apps);
    const projectDefaultApps = parseJsonArray(project.defaultApps);
    const kind: EnvironmentKind = options.kind === "LITE" ? "LITE" : "FULL";
    const apps =
      kind === "LITE"
        ? []
        : (options.apps ??
          (projectDefaultApps.length > 0 ? projectDefaultApps : projectApps));

    const environment = await this.prisma.environment.create({
      data: {
        name: envName,
        projectId: project.id,
        branch,
        baseBranch: options.baseBranch ?? project.defaultBaseBranch,
        worktreePath,
        status: "CREATING",
        kind,
        apps: toJsonArray(apps),
      },
    });
    emit({ type: "step", id: "worktree", status: "skip" });

    // LITE: the checkout is usable by an agent right away; ports, database
    // and deps come later, on the first `devflow run`, through promote.
    if (kind === "LITE") {
      await this.prepareWorktree(project, worktreePath);
      await this.envFileService.copyEnvFiles(project.path, worktreePath);
      const ready = await this.prisma.environment.update({
        where: { id: environment.id },
        data: { status: "RUNNING" },
        include: {
          database: true,
          ports: true,
          processes: true,
          project: true,
        },
      });
      this.mirrorToHerdr(ready);
      emit({ type: "done", environment: ready });
      return ready;
    }

    try {
      await this.prepareWorktree(project, worktreePath);
      await this.provisionFullResources({
        environmentId: environment.id,
        envName,
        worktreePath,
        project,
        apps,
        seedStrategy: options.seedStrategy,
        snapshotPath: options.snapshotPath,
        skipInstall: options.skipInstall ?? false,
        emit,
      });

      const ready = await this.prisma.environment.update({
        where: { id: environment.id },
        data: { status: "RUNNING" },
        include: {
          database: true,
          ports: true,
          processes: true,
          project: true,
        },
      });
      this.mirrorToHerdr(ready);
      emit({ type: "done", environment: ready });
      return ready;
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      // The worktree is not ours to remove; only release what was provisioned.
      try {
        await this.teardownEnvironment(environment.id);
      } catch {
        await this.prisma.environment.update({
          where: { id: environment.id },
          data: { status: "ERROR" },
        });
      }
      throw error;
    }
  }

  /**
   * Rewrite the environment's `.env` files from the main checkout's: database
   * URL and ports of this environment. For when the main files changed, or a
   * file was overwritten by hand.
   */
  async regenerateEnvFiles(environmentId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, ports: true, project: true },
    });
    if (!env?.project)
      throw new Error(`Environment not found: ${environmentId}`);
    if (env.kind === "LITE") {
      await this.envFileService.copyEnvFiles(
        env.project.path,
        env.worktreePath,
      );
      return;
    }
    const portsMap: Record<string, number> = {};
    for (const p of env.ports) portsMap[p.appName] = p.port;
    await this.envFileService.generateEnvFiles({
      worktreePath: env.worktreePath,
      projectPath: env.project.path,
      databaseUrl: env.database?.url ?? "",
      dbEnvVarName: env.project.dbEnvVarName,
      ports: portsMap,
      originalPorts:
        parseJsonObject<Record<string, number>>(env.project.appPorts) ?? {},
    });
  }

  /** The environment whose worktree is `dir` (symlinks resolved), if any. */
  async findByWorktreePath(dir: string) {
    const target = await safeRealpath(dir);
    const candidates = await this.prisma.environment.findMany({
      where: { worktreePath: { not: "" } },
      include: { database: true, ports: true, processes: true, project: true },
    });
    for (const env of candidates) {
      if ((await safeRealpath(env.worktreePath)) === target) return env;
    }
    return null;
  }

  /**
   * Release everything DevFlow provisioned, leaving the checkout in place.
   * The counterpart of adoptWorktree: herdr removes the worktree itself.
   */
  async teardownEnvironment(environmentId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, processes: true },
    });
    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "DESTROYING" },
    });
    await this.releaseResources(env);
    await this.prisma.environment.delete({ where: { id: environmentId } });
  }

  /** Kill the environment's processes and drop its database container. */
  private async releaseResources(env: {
    id: string;
    processes: { pid: number | null; status: string }[];
    database: { name: string } | null;
  }): Promise<void> {
    await this.killProcessesByPid(env.processes);
    if (env.database) {
      await this.dockerService.destroyContainer(env.database.name);
    }
    // The dev-server output outlives the processes on disk; an environment
    // whose resources are gone has no logs anyone can still act on.
    await rm(environmentLogFile(env.id), { force: true }).catch(
      () => undefined,
    );
  }

  /**
   * Per-checkout files an agent expects: the project's local Claude settings.
   * No MCP config: agents drive DevFlow through its CLI (see the `devflow`
   * skill), which costs nothing per agent, unlike one MCP server each.
   */
  private async prepareWorktree(
    project: Project,
    worktreePath: string,
  ): Promise<void> {
    const claudeSettingsSource = join(
      project.path,
      ".claude",
      "settings.local.json",
    );
    if (await fs.pathExists(claudeSettingsSource)) {
      await fs.ensureDir(join(worktreePath, ".claude"));
      await fs.copy(
        claudeSettingsSource,
        join(worktreePath, ".claude", "settings.local.json"),
      );
    }
  }

  /**
   * Upgrade a LITE (worktree-only) environment to a FULL one by provisioning
   * everything createEnvironment skipped: ports, database, install, .env, seed.
   * The worktree is left untouched, so work in progress survives.
   */
  async promoteEnvironment(
    environmentId: string,
    options: {
      seedStrategy?: string;
      snapshotPath?: string;
      apps?: string[];
    } = {},
    onProgress?: OnProgress,
  ): Promise<Environment> {
    const emit = (event: CreateEnvProgress) => onProgress?.(event);
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, project: true },
    });

    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }
    if (!env.project) {
      throw new Error("Environment has no project");
    }
    if (env.kind !== "LITE" || env.database) {
      throw new Error("Environment already has full resources");
    }

    const project = env.project;
    const projectApps = parseJsonArray(project.apps);
    const projectDefaultApps = parseJsonArray(project.defaultApps);
    const apps =
      options.apps ??
      (projectDefaultApps.length > 0 ? projectDefaultApps : projectApps);

    await this.prisma.environment.update({
      where: { id: env.id },
      data: { status: "CREATING" },
    });

    try {
      // Clear leftovers from a previously failed promote so a retry doesn't
      // hit the (environmentId, appName) unique constraint.
      await this.prisma.portAllocation.deleteMany({
        where: { environmentId: env.id },
      });

      // Skip install when the worktree already has its dependencies.
      const hasNodeModules = await fs.pathExists(
        join(env.worktreePath, "node_modules"),
      );
      await this.provisionFullResources({
        environmentId: env.id,
        envName: env.name,
        worktreePath: env.worktreePath,
        project,
        apps,
        seedStrategy: options.seedStrategy,
        snapshotPath: options.snapshotPath,
        skipInstall: hasNodeModules,
        emit,
      });

      const ready = await this.prisma.environment.update({
        where: { id: env.id },
        data: { kind: "FULL", apps: toJsonArray(apps), status: "RUNNING" },
        include: {
          database: true,
          ports: true,
          processes: true,
          project: true,
        },
      });
      this.mirrorToHerdr(ready);
      emit({ type: "done", environment: ready });
      return ready;
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      // Never destroy on failure — the worktree may hold work in progress.
      // Hand the env back as a working LITE one; a retry re-runs the steps.
      await this.prisma.environment.update({
        where: { id: env.id },
        data: { status: "RUNNING" },
      });
      throw error;
    }
  }

  /** Steps 2-6 of environment creation: ports, database, install, .env, seed. */
  private provisionFullResources(params: {
    environmentId: string;
    envName: string;
    worktreePath: string;
    project: Project;
    apps: string[];
    seedStrategy?: string;
    snapshotPath?: string;
    skipInstall: boolean;
    emit: (event: CreateEnvProgress) => void;
  }): Promise<void> {
    return withProvisionLock(() => this.provisionFullResourcesNow(params));
  }

  private async provisionFullResourcesNow(params: {
    environmentId: string;
    envName: string;
    worktreePath: string;
    project: Project;
    apps: string[];
    seedStrategy?: string;
    snapshotPath?: string;
    skipInstall: boolean;
    emit: (event: CreateEnvProgress) => void;
  }): Promise<void> {
    const {
      environmentId,
      envName,
      worktreePath,
      project,
      apps,
      skipInstall,
      emit,
    } = params;

    // Allocate ports (exclude original app ports to avoid proxy conflicts)
    emit({ type: "step", id: "ports", status: "start" });
    const appPorts =
      parseJsonObject<Record<string, number>>(project.appPorts) ?? {};
    const portAllocations = await this.portService.allocatePorts(
      environmentId,
      apps,
      Object.values(appPorts),
    );
    const portsMap: Record<string, number> = {};
    for (const alloc of portAllocations) {
      portsMap[alloc.appName] = alloc.port;
    }
    emit({ type: "step", id: "ports", status: "done" });

    // Create database
    emit({ type: "step", id: "database", status: "start" });
    const dbPort = await this.portService.allocateDatabasePort();
    const dbRecord = await this.dockerService.createContainer(
      environmentId,
      envName,
      dbPort,
      project.dbDockerImage,
    );
    emit({ type: "step", id: "database", status: "done" });

    // Install dependencies
    if (skipInstall) {
      emit({ type: "step", id: "install", status: "skip" });
    } else {
      emit({ type: "step", id: "install", status: "start" });
      await this.installDependencies(worktreePath);
      emit({ type: "step", id: "install", status: "done" });
    }

    // Generate .env files
    emit({ type: "step", id: "env", status: "start" });
    await this.envFileService.generateEnvFiles({
      worktreePath,
      projectPath: project.path,
      databaseUrl: dbRecord.url,
      dbEnvVarName: project.dbEnvVarName,
      ports: portsMap,
      // Without this, cross-app URLs (API_URL, NEXT_PUBLIC_API_URL, CORS
      // lists) keep pointing at the main checkout's ports on first provision.
      originalPorts: appPorts,
    });
    emit({ type: "step", id: "env", status: "done" });

    // Seed database
    emit({ type: "step", id: "seed", status: "start" });
    const config = await this.configService.getOrCreateConfig();
    const seedStrategy =
      params.seedStrategy ?? project.defaultSeed ?? config.dbSeedStrategy;
    if (seedStrategy === "COPY_MAIN") {
      const sourceDatabaseUrl = project.sourceDatabaseUrl;
      if (sourceDatabaseUrl) {
        await this.dockerService.seedDatabase(
          { worktreePath, database: dbRecord },
          "COPY_MAIN",
          { sourceDatabaseUrl },
        );
      }
      // Apply pending migrations from the branch on top of the copied database
      await this.dockerService.applyMigrations({
        worktreePath,
        database: dbRecord,
      });
    } else {
      await this.dockerService.seedDatabase(
        { worktreePath, database: dbRecord },
        seedStrategy as "COPY_MAIN" | "FRESH_MIGRATE" | "SNAPSHOT",
        { snapshotPath: params.snapshotPath },
      );
    }
    emit({ type: "step", id: "seed", status: "done" });
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    try {
      await execa("pnpm", ["install"], { cwd: worktreePath });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        throw new Error(
          "pnpm is not on PATH. DevFlow installs a worktree's dependencies with pnpm; " +
            "install it (https://pnpm.io/installation), or provision with --skip-install " +
            "and install them yourself.",
        );
      }
      throw error;
    }
    const databasePath = join(worktreePath, "packages", "database");
    if (await fs.pathExists(databasePath)) {
      await execa("pnpm", ["prisma", "generate"], { cwd: databasePath });
    }
    // Workspace packages consumed through their `dist` (the main checkout
    // has them from an old build; a fresh worktree has nothing). Turbo's
    // cache makes this near-free after the first environment.
    if (await fs.pathExists(join(worktreePath, "turbo.json"))) {
      await execa("pnpm", ["turbo", "run", "build", "--filter=./packages/*"], {
        cwd: worktreePath,
      }).catch(() => {
        // Not every package builds; a failure here must not block the env.
      });
    }
  }

  async startEnvironment(environmentId: string): Promise<Environment> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, ports: true, project: true },
    });

    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }

    if (env.database) {
      await execa("docker", ["start", env.database.containerName]);

      // Sync port in case Docker assigned a different one
      const actualPort = await this.dockerService.getContainerPort(
        env.database.containerName,
      );
      if (actualPort !== env.database.port) {
        const newUrl = `postgresql://${env.database.user}:${env.database.password}@${env.database.host}:${actualPort}/${env.database.name}`;
        await this.prisma.environmentDatabase.update({
          where: { id: env.database.id },
          data: { port: actualPort, url: newUrl },
        });

        // Regenerate .env files with updated database URL
        if (env.project) {
          const portsMap: Record<string, number> = {};
          for (const p of env.ports) {
            portsMap[p.appName] = p.port;
          }
          await this.envFileService.generateEnvFiles({
            worktreePath: env.worktreePath,
            projectPath: env.project.path,
            databaseUrl: newUrl,
            dbEnvVarName: env.project.dbEnvVarName,
            ports: portsMap,
            originalPorts:
              parseJsonObject<Record<string, number>>(env.project.appPorts) ??
              {},
          });
        }
      }
    }

    const started = await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "RUNNING" },
      include: {
        database: true,
        ports: true,
        processes: true,
        project: true,
      },
    });
    this.mirrorToHerdr(started);
    return started;
  }

  async stopEnvironment(environmentId: string): Promise<Environment> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, processes: true },
    });

    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }

    // Kill running processes by PID
    await this.killProcessesByPid(env.processes);

    if (env.database) {
      await this.dockerService.stopContainer(env.database.containerName);
    }

    const stopped = await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "STOPPED" },
      include: {
        database: true,
        ports: true,
        processes: true,
        project: true,
      },
    });
    this.mirrorToHerdr(stopped);
    return stopped;
  }

  async destroyEnvironment(environmentId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { database: true, project: true, processes: true },
    });

    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }

    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "DESTROYING" },
    });

    await this.releaseResources(env);

    // Close the herdr workspace first: its shells hold the worktree open.
    if (env.worktreePath) {
      await this.herdrService.closeWorkspacesAt(env.worktreePath).catch(() => {
        // Not installed, or the server is down — nothing to close.
      });
    }

    // Remove worktree
    if (env.worktreePath && env.project) {
      await this.worktreeService.removeWorktree(
        env.worktreePath,
        env.project.path,
      );
    }

    // Delete environment and all related records (cascade)
    await this.prisma.environment.delete({
      where: { id: environmentId },
    });
  }

  async getEnvironment(environmentId: string) {
    return this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: {
        database: true,
        ports: true,
        processes: true,
        project: true,
      },
    });
  }

  async getEnvironmentByName(name: string) {
    return this.prisma.environment.findUnique({
      where: { name },
      include: {
        database: true,
        ports: true,
        processes: true,
        project: true,
      },
    });
  }

  async listEnvironments(projectId?: string) {
    return this.prisma.environment.findMany({
      where: projectId ? { projectId } : undefined,
      include: {
        database: true,
        ports: true,
        processes: true,
        project: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getDiff(environmentId: string): Promise<string> {
    const env = await this.findEnvOrThrow(environmentId);
    return this.worktreeService.getDiff(env.worktreePath, env.baseBranch);
  }

  async getChanges(environmentId: string): Promise<string> {
    const env = await this.findEnvOrThrow(environmentId);
    return this.worktreeService.getChanges(env.worktreePath);
  }

  async getHistory(environmentId: string) {
    const env = await this.findEnvOrThrow(environmentId);
    return this.worktreeService.getHistory(env.worktreePath, env.baseBranch);
  }

  private async killProcessesByPid(
    processes: { pid: number | null; status: string }[],
  ): Promise<void> {
    for (const proc of processes) {
      if (proc.pid && proc.status === "RUNNING") {
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          try {
            process.kill(proc.pid, "SIGTERM");
          } catch {
            // Already dead
          }
        }
      }
    }
  }

  private async findEnvOrThrow(environmentId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
    });
    if (!env) {
      throw new Error(`Environment not found: ${environmentId}`);
    }
    return env;
  }
}
