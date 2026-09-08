import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "../lib/package-paths.js";
import { devflowHome } from "./paths.js";
import type { PrismaClient } from "./types.js";

/** The `prisma/migrations` directory shipped inside the package. */
function migrationsDir(): string {
  return join(packageRoot(), "prisma", "migrations");
}

type Migration = { name: string; sql: string };

async function loadMigrations(): Promise<Migration[]> {
  const dir = migrationsDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const migrations: Migration[] = [];

  for (const entry of entries.filter(e => e.isDirectory()).sort()) {
    const sql = await readFile(
      join(dir, entry.name, "migration.sql"),
      "utf8",
    ).catch(() => null);
    if (sql !== null) migrations.push({ name: entry.name, sql });
  }

  return migrations.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * SQLite has no way to run several statements in one `$executeRawUnsafe`, so
 * a migration file is applied statement by statement. Prisma's generated SQL
 * has no string literals containing semicolons, which keeps the split honest.
 */
function statements(sql: string): string[] {
  return sql
    .split(";")
    .map(s =>
      s
        .split("\n")
        .filter(line => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/**
 * Bring the local database up to date before any command touches it.
 *
 * There is no `prisma` binary to shell out to in an installed package, so the
 * migration SQL that ships with it is applied directly. The bookkeeping goes
 * into `_prisma_migrations` in Prisma's own format, so `prisma migrate deploy`
 * against the same file later agrees about what has already run.
 */
export async function ensureDatabase(prisma: PrismaClient): Promise<void> {
  await mkdir(devflowHome(), { recursive: true });

  const migrations = await loadMigrations();
  if (migrations.length === 0) return;

  await prisma.$executeRawUnsafe(MIGRATIONS_TABLE);

  const applied = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
  );
  const done = new Set(applied.map(row => row.migration_name));

  for (const migration of migrations) {
    if (done.has(migration.name)) continue;

    const steps = statements(migration.sql);
    for (const statement of steps) {
      await prisma.$executeRawUnsafe(statement);
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
         ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
       VALUES (?, ?, current_timestamp, ?, current_timestamp, ?)`,
      randomUUID(),
      createHash("sha256").update(migration.sql).digest("hex"),
      migration.name,
      steps.length,
    );
  }
}
