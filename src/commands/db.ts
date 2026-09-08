import { Command } from "commander";
import { execa } from "execa";
import { prisma } from "../db/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { ensureFull } from "../lib/ensure-full.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";

/**
 * `devflow db`: lazysql on the environment's Postgres, in the terminal.
 * `--url` prints just the connection string, for psql or Beekeeper; `--json`
 * prints host, port, user and database alongside it.
 *
 * Both flags provision a LITE environment first: there is no database to
 * connect to until then.
 */
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
      const env = await ensureFull(
        await resolveEnvironment({ name: envName }),
        { quiet: options.json },
      );
      if (!env.database)
        throw new DevflowError("NO_DATABASE", `${env.name} has no database`);
      if (env.status !== "RUNNING") {
        throw new DevflowError(
          "ENVIRONMENT_NOT_RUNNING",
          `${env.name} is ${env.status.toLowerCase()}; start it first: devflow start ${env.name}`,
        );
      }
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
