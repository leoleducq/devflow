import { execa } from "execa";
import { join } from "node:path";
import fs from "fs-extra";
import type { PrismaClient } from "../db/types.js";
import {
  resolvePackageManager,
  execBinaryArgv,
} from "../lib/package-manager.js";

/**
 * A worktree whose Prisma commands have to run. `packageManager` is the
 * project's pinned choice; undefined or null means detect it from the
 * checkout, which is what every project that never set one gets.
 */
type PrismaTarget = {
  worktreePath: string;
  packageManager?: string | null;
};

type DatabaseContainerConfig = {
  name: string;
  port: number;
  host: string;
  user: string;
  password: string;
};

export class DockerDatabaseService {
  constructor(private readonly prisma: PrismaClient) {}

  async createContainer(
    environmentId: string,
    envName: string,
    port: number,
    dockerImage: string = "postgres:15-alpine",
  ): Promise<{
    name: string;
    port: number;
    host: string;
    user: string;
    password: string;
    url: string;
    containerName: string;
  }> {
    const dbName = envName.replace(/-/g, "_");
    const containerName = `devflow-db-${dbName}`;
    const host = "localhost";
    const user = "postgres";
    const password = "postgres";
    const url = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;

    // Check if container already exists
    try {
      const { stdout } = await execa("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${containerName}`,
        "--format",
        "{{.Names}}",
      ]);
      if (stdout.includes(containerName)) {
        await execa("docker", ["start", containerName]);
        await this.waitForReady({ name: dbName, port, host, user, password });

        const dbRecord = await this.prisma.environmentDatabase.create({
          data: {
            environmentId,
            name: dbName,
            port,
            host,
            user,
            password,
            url,
            containerName,
          },
        });

        return dbRecord;
      }
    } catch {
      // Container doesn't exist, continue to create
    }

    await execa("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_DB=${dbName}`,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      `${port}:5432`,
      "-v",
      `devflow-${dbName}:/var/lib/postgresql/data`,
      dockerImage,
    ]);

    await this.waitForReady({ name: dbName, port, host, user, password });

    const dbRecord = await this.prisma.environmentDatabase.create({
      data: {
        environmentId,
        name: dbName,
        port,
        host,
        user,
        password,
        url,
        containerName,
      },
    });

    return dbRecord;
  }

  async getContainerPort(containerName: string): Promise<number> {
    const { stdout } = await execa("docker", ["port", containerName, "5432"]);
    // Output format: "0.0.0.0:64718" or "[::]:64718"
    const match = stdout.match(/:(\d+)$/m);
    if (!match) {
      throw new Error(
        `Could not determine port for container ${containerName}`,
      );
    }
    return parseInt(match[1]!, 10);
  }

  async stopContainer(containerName: string): Promise<void> {
    try {
      await execa("docker", ["stop", containerName]);
    } catch {
      // Container might not exist or already stopped
    }
  }

  async destroyContainer(dbName: string): Promise<void> {
    const containerName = `devflow-db-${dbName}`;
    try {
      await execa("docker", ["rm", "-f", containerName]);
      await execa("docker", ["volume", "rm", `devflow-${dbName}`]);
    } catch {
      // Container/volume might not exist
    }
  }

  async seedDatabase(
    env: PrismaTarget & {
      database: { name: string; user: string; url: string };
    },
    strategy: "COPY_MAIN" | "FRESH_MIGRATE" | "SNAPSHOT",
    options?: {
      sourceDatabaseUrl?: string;
      snapshotPath?: string;
    },
  ): Promise<void> {
    switch (strategy) {
      case "COPY_MAIN":
        if (options?.sourceDatabaseUrl) {
          await this.copyFromExternalDatabase(env, options.sourceDatabaseUrl);
        }
        break;
      case "FRESH_MIGRATE":
        await this.runFreshMigrations(env);
        break;
      case "SNAPSHOT":
        if (options?.snapshotPath) {
          await this.restoreSnapshot(env, options.snapshotPath);
        }
        break;
    }
  }

  async createSnapshot(
    dbName: string,
    dbUser: string,
    outputPath: string,
  ): Promise<void> {
    const containerName = `devflow-db-${dbName}`;
    await fs.ensureDir(join(outputPath, ".."));

    const { stdout } = await execa("docker", [
      "exec",
      containerName,
      "pg_dump",
      "-U",
      dbUser,
      "-d",
      dbName,
    ]);

    await fs.writeFile(outputPath, stdout);
  }

  private async copyFromExternalDatabase(
    env: { database: { name: string; user: string } },
    sourceDatabaseUrl: string,
  ): Promise<void> {
    // Parse the source URL to determine the PostgreSQL version, then use a
    // matching pg_dump via Docker to avoid version mismatch errors.
    // We run pg_dump inside a temporary postgres container with --network host
    // so it can reach the host's PostgreSQL server.
    const serverVersion = await this.getServerMajorVersion(sourceDatabaseUrl);
    const pgImage = `postgres:${serverVersion}-alpine`;

    // On macOS, --network host doesn't work with Docker Desktop.
    // Replace localhost/127.0.0.1 with host.docker.internal so the container
    // can reach the host's PostgreSQL server.
    const containerDbUrl = sourceDatabaseUrl
      .replace("localhost", "host.docker.internal")
      .replace("127.0.0.1", "host.docker.internal");

    const { stdout: dumpData } = await execa("docker", [
      "run",
      "--rm",
      "--network",
      "host",
      pgImage,
      "pg_dump",
      containerDbUrl,
    ]);

    await execa(
      "docker",
      [
        "exec",
        "-i",
        `devflow-db-${env.database.name}`,
        "psql",
        "-U",
        env.database.user,
        "-d",
        env.database.name,
      ],
      { input: dumpData },
    );
  }

  private async getServerMajorVersion(databaseUrl: string): Promise<number> {
    try {
      const containerUrl = databaseUrl
        .replace("localhost", "host.docker.internal")
        .replace("127.0.0.1", "host.docker.internal");

      const { stdout } = await execa("docker", [
        "run",
        "--rm",
        "--network",
        "host",
        "postgres:16-alpine",
        "psql",
        containerUrl,
        "-t",
        "-A",
        "-c",
        "SHOW server_version;",
      ]);
      const major = parseInt(stdout.trim().split(".")[0]!, 10);
      if (!isNaN(major) && major >= 12) return major;
    } catch {
      // Fallback to 16 if we can't determine version
    }
    return 16;
  }

  /**
   * Directory holding the worktree's Prisma schema, or null when the project
   * does not use Prisma. Plenty of projects don't: they get an empty database
   * and manage their own schema, which is not an error.
   */
  private async findPrismaSchemaDir(
    worktreePath: string,
  ): Promise<string | null> {
    const candidates = [
      join(worktreePath, "packages", "database", "prisma", "schema.prisma"),
      join(worktreePath, "prisma", "schema.prisma"),
    ];

    for (const candidate of candidates) {
      if (await fs.pathExists(candidate)) return join(candidate, "..");
    }
    return null;
  }

  /** `prisma migrate deploy`, spelled for the project's package manager. */
  private async prismaArgv(
    env: PrismaTarget,
    args: string[],
  ): Promise<{ command: string; args: string[] }> {
    const manager = await resolvePackageManager(
      env.worktreePath,
      env.packageManager,
    );
    return execBinaryArgv(manager, "prisma", args);
  }

  async applyMigrations(
    env: PrismaTarget & { database: { url: string } },
  ): Promise<void> {
    const schemaDir = await this.findPrismaSchemaDir(env.worktreePath);
    if (!schemaDir) return;

    const migrate = await this.prismaArgv(env, ["migrate", "deploy"]);
    try {
      await execa(migrate.command, migrate.args, {
        cwd: schemaDir,
        env: { DATABASE_URL: env.database.url },
      });
    } catch {
      // No pending migrations — safe to ignore
    }
  }

  private async runFreshMigrations(
    env: PrismaTarget & { database: { url: string } },
  ): Promise<void> {
    const schemaDir = await this.findPrismaSchemaDir(env.worktreePath);
    // No Prisma in this project: the container is up and empty, which is all
    // FRESH_MIGRATE can mean here. Failing would make the strategy unusable
    // for every project that manages its schema some other way.
    if (!schemaDir) return;

    const migrate = await this.prismaArgv(env, ["migrate", "deploy"]);
    await execa(migrate.command, migrate.args, {
      cwd: schemaDir,
      env: { DATABASE_URL: env.database.url },
    });

    const seed = await this.prismaArgv(env, ["db", "seed"]);
    try {
      await execa(seed.command, seed.args, {
        cwd: schemaDir,
        env: { DATABASE_URL: env.database.url },
      });
    } catch {
      // Seed might not exist
    }
  }

  private async restoreSnapshot(
    env: { database: { name: string; user: string } },
    snapshotPath: string,
  ): Promise<void> {
    if (!(await fs.pathExists(snapshotPath))) {
      throw new Error(`Snapshot not found: ${snapshotPath}`);
    }

    const dumpData = await fs.readFile(snapshotPath, "utf-8");

    await execa(
      "docker",
      [
        "exec",
        "-i",
        `devflow-db-${env.database.name}`,
        "psql",
        "-U",
        env.database.user,
        "-d",
        env.database.name,
      ],
      { input: dumpData },
    );
  }

  async executeQuery(
    connectionUrl: string,
    query: string,
  ): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number;
    fields: string[];
    command: string;
  }> {
    const pg = await import("pg");
    const Client = pg.default?.Client ?? pg.Client;
    const client = new Client({ connectionString: connectionUrl });

    try {
      await client.connect();
      const result = await client.query(query);

      return {
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? 0,
        fields: (result.fields ?? []).map((f: { name: string }) => f.name),
        command: result.command ?? "",
      };
    } finally {
      await client.end();
    }
  }

  private async waitForReady(config: DatabaseContainerConfig): Promise<void> {
    // Postgres takes well over 30s to answer when several environments
    // provision at once; give it time rather than fail a whole provisioning.
    const maxRetries = 120;
    let retries = 0;
    const containerName = `devflow-db-${config.name}`;

    while (retries < maxRetries) {
      try {
        await execa("docker", [
          "exec",
          containerName,
          "pg_isready",
          "-U",
          config.user,
        ]);
        return;
      } catch {
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(
      `Database ${config.name} failed to start after ${maxRetries} seconds`,
    );
  }
}
