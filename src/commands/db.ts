import { Command } from "commander";
import chalk from "chalk";
import { execa } from "execa";
import { prisma } from "../db/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { ensureFull } from "../lib/ensure-full.js";

/**
 * `devflow db`: lazysql on the environment's Postgres, in the terminal.
 * `--url` only prints the connection string, for Beekeeper or psql.
 */
export const dbCommand = new Command()
  .name("db")
  .description(
    "Open lazysql on an environment's database (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("--url", "Print the connection URL instead of opening lazysql")
  .action(async (envName: string | undefined, options) => {
    try {
      const env = await ensureFull(await resolveEnvironment({ name: envName }));
      if (!env.database) throw new Error(`${env.name} has no database`);
      if (env.status !== "RUNNING") {
        throw new Error(
          `${env.name} is ${env.status.toLowerCase()}; start it first: devflow start ${env.name}`,
        );
      }
      if (options.url) {
        console.log(env.database.url);
        return;
      }
      await prisma.$disconnect();
      await execa("lazysql", [env.database.url], { stdio: "inherit" });
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    }
  });
