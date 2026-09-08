import { Command } from "commander";
import { execa } from "execa";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { DockerDatabaseService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { ensureFull } from "../lib/ensure-full.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";
import { printTable } from "../lib/table.js";
import { DevflowError } from "../lib/errors.js";
import { snapshotDir, snapshotPath } from "../lib/seed-strategy.js";
import { commandOptions } from "../lib/command-options.js";

/**
 * `devflow db`: lazysql on the environment's Postgres, in the terminal.
 * `--url` prints just the connection string, for psql or Beekeeper; `--json`
 * prints host, port, user and database alongside it.
 *
 * Both flags provision a LITE environment first: there is no database to
 * connect to until then.
 */

type ResolvedEnv = Awaited<ReturnType<typeof ensureFull>>;

/** The environment's running database, or the reason there is not one. */
const requireDatabase = async (
  envName: string | undefined,
  json: boolean,
): Promise<ResolvedEnv & { database: NonNullable<ResolvedEnv["database"]> }> => {
  const env = await ensureFull(await resolveEnvironment({ name: envName }), {
    quiet: json,
  });
  if (!env.database)
    throw new DevflowError("NO_DATABASE", `${env.name} has no database`);
  if (env.status !== "RUNNING") {
    throw new DevflowError(
      "ENVIRONMENT_NOT_RUNNING",
      `${env.name} is ${env.status.toLowerCase()}; start it first: devflow start ${env.name}`,
    );
  }
  return env as ResolvedEnv & { database: NonNullable<ResolvedEnv["database"]> };
};

export const dbCommand = new Command()
  .name("db")
  .description(
    "Open lazysql on an environment's database (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--url", "Print the connection URL instead of opening lazysql")
  .option("--json", "Print the connection details as JSON")
  .action(async (envName: string | undefined, options) => {
    try {
      const env = await requireDatabase(envName, !!options.json);
      if (options.json) {
        const { name, port, host, user, url } = env.database;
        printJson({
          environment: env.name,
          database: name,
          host,
          port,
          user,
          url,
        });
        return;
      }
      if (options.url) {
        console.log(env.database.url);
        return;
      }
      await prisma.$disconnect();
      await execa("lazysql", [env.database.url], { stdio: "inherit" });
    } catch (error) {
      failCommand(error, options.json);
    }
  });

/**
 * `devflow db query`: raw SQL against the environment's Postgres.
 *
 * This is the one capability an agent used the desktop app's embedded Studio
 * for — read a row, fix a row, check what a migration did — and the one that
 * translates to a CLI without loss. It is the environment's own throwaway
 * database, so writes are not gated: destroying it is `devflow destroy`.
 */
dbCommand
  .command("query")
  .description("Run SQL against an environment's database")
  .argument("[sql]", "The statement to run (omit with --file)")
  .option("-e, --env <env-name>", "Environment (default: the one of cwd)")
  .option("-f, --file <path>", "Read the statement from a file instead")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow db query "select count(*) from users"
  $ devflow db query "update \\"user\\" set credits = 100 where email = 'a@b.c'"
  $ devflow db query --file seed.sql
  $ devflow db query "select * from site limit 5" --json`,
  )
  .action(async (sql: string | undefined, _flags, command) => {
    const options = commandOptions<{
      env?: string;
      file?: string;
      json?: boolean;
    }>(command);
    try {
      if (!sql && !options.file) {
        throw new DevflowError(
          "INPUT_REQUIRED",
          "Pass the SQL as an argument, or read it from a file with --file <path>.",
        );
      }

      const statement =
        sql ?? (await readFile(resolve(options.file!), "utf-8"));
      const env = await requireDatabase(options.env, !!options.json);

      const result = await new DockerDatabaseService(prisma).executeQuery(
        env.database.url,
        statement,
      );

      if (options.json) {
        printJson({
          environment: env.name,
          command: result.command,
          rowCount: result.command === "SELECT" ? result.rows.length : result.rowCount,
          fields: result.fields,
          rows: result.rows,
        });
        return;
      }

      if (result.rows.length === 0) {
        console.log(
          colors.green(
            `${result.command || "OK"} — ${result.rowCount} row(s) affected`,
          ),
        );
        return;
      }

      // A result set is a table; nulls are dimmed so an empty cell is not
      // mistaken for the string "null".
      printTable(
        result.rows.map(row =>
          result.fields.map(field => {
            const value = row[field];
            if (value === null || value === undefined) return colors.dim("null");
            return typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
          }),
        ),
        { columns: result.fields.map(field => ({ header: field })) },
      );
      console.log();
      console.log(colors.dim(`${result.rows.length} row(s)`));
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow db snapshot`: a pg_dump of the environment's database, kept under
 * ~/.devflow/snapshots so `--seed snapshot:<name>` can restore it into the
 * next environment. That is the whole point: a slow COPY_MAIN once, then
 * every later environment seeded from the dump in seconds.
 */
dbCommand
  .command("snapshot")
  .description("Dump an environment's database to a reusable snapshot")
  .argument("<name>", "Snapshot name, or a path ending in .sql")
  .option("-e, --env <env-name>", "Environment (default: the one of cwd)")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow db snapshot before-migration
  $ devflow create myapp feat/x --seed snapshot:before-migration
  $ devflow db snapshot ./dumps/prod-like.sql`,
  )
  .action(async (name: string, _flags, command) => {
    const options = commandOptions<{ env?: string; json?: boolean }>(command);
    try {
      const env = await requireDatabase(options.env, !!options.json);
      const output = snapshotPath(name);

      const spinner = startSpinner(`Dumping ${env.database.name}…`, options.json);
      await new DockerDatabaseService(prisma).createSnapshot(
        env.database.name,
        env.database.user,
        output,
      );
      spinner.succeed(colors.green(`Snapshot written to ${output}`));

      if (options.json) {
        printJson({ environment: env.name, snapshot: name, path: output });
        return;
      }
      console.log();
      console.log(
        colors.dim("Seed a new environment from it with:"),
        colors.white(`devflow create <project> <branch> --seed snapshot:${name}`),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow db snapshots`: what `--seed snapshot:<name>` can restore. A
 * snapshot the user cannot list is a snapshot they will not use.
 */
dbCommand
  .command("snapshots")
  .description("List the snapshots available to --seed snapshot:<name>")
  .option("--json", "Machine-readable output")
  .action(async (_flags, command) => {
    const options = commandOptions<{ json?: boolean }>(command);
    try {
      const dir = snapshotDir();
      const files = (await readdir(dir).catch(() => [])).filter(file =>
        file.endsWith(".sql"),
      );

      const snapshots = await Promise.all(
        files.map(async file => {
          const path = join(dir, file);
          const info = await stat(path);
          return {
            name: file.replace(/\.sql$/, ""),
            path,
            bytes: info.size,
            createdAt: info.mtime.toISOString(),
          };
        }),
      );
      snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      if (options.json) {
        printJson(snapshots);
        return;
      }
      if (snapshots.length === 0) {
        console.log(colors.yellow("No snapshot yet"));
        console.log(
          colors.dim("Take one with:"),
          colors.white("devflow db snapshot <name>"),
        );
        return;
      }
      printTable(
        snapshots.map(snapshot => [
          colors.bold(snapshot.name),
          `${(snapshot.bytes / 1024 / 1024).toFixed(1)} MB`,
          colors.dim(snapshot.createdAt.slice(0, 10)),
        ]),
        {
          columns: [
            { header: "NAME" },
            { header: "SIZE", align: "right" },
            { header: "TAKEN" },
          ],
        },
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
