import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import {
  ConfigService,
  CONFIG_FIELDS,
  SEED_STRATEGIES,
} from "../services/config-service.js";
import type { ConfigField, ConfigUpdate } from "../services/config-service.js";

/** Fields stored as numbers; everything else in CONFIG_FIELDS is a string. */
const NUMERIC_FIELDS = new Set<ConfigField>([
  "portRangeStart",
  "portRangeSize",
  "dbDefaultPort",
]);

const isConfigField = (value: string): value is ConfigField =>
  (CONFIG_FIELDS as readonly string[]).includes(value);

/**
 * Turn a command-line string into the typed value the column expects. Anything
 * that is not a clean number for a numeric field is rejected here rather than
 * silently stored as NaN.
 */
function coerce(field: ConfigField, raw: string): ConfigUpdate[ConfigField] {
  if (!NUMERIC_FIELDS.has(field)) return raw;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${field} expects an integer, got '${raw}'`);
  }
  return value;
}

export const configCommand = new Command()
  .name("config")
  .description("Read and change DevFlow's global settings");

configCommand
  .command("get")
  .description("Print the global settings")
  .argument("[field]", `One of: ${CONFIG_FIELDS.join(", ")}`)
  .option("--json", "Machine-readable output")
  .action(async (field: string | undefined, options) => {
    try {
      const config = await new ConfigService(prisma).getOrCreateConfig();

      if (field) {
        if (!isConfigField(field)) {
          throw new Error(
            `Unknown setting '${field}'. Known settings: ${CONFIG_FIELDS.join(", ")}`,
          );
        }
        console.log(String(config[field]));
        return;
      }

      const values = Object.fromEntries(
        CONFIG_FIELDS.map(name => [name, config[name]]),
      );

      if (options.json) {
        console.log(JSON.stringify(values, null, 2));
        return;
      }

      const width = Math.max(...CONFIG_FIELDS.map(f => f.length));
      for (const [name, value] of Object.entries(values)) {
        console.log(`${chalk.bold(name.padEnd(width))}  ${String(value)}`);
      }
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

configCommand
  .command("set")
  .description("Change one global setting")
  .argument("<field>", `One of: ${CONFIG_FIELDS.join(", ")}`)
  .argument("<value>", "New value")
  .action(async (field: string, value: string) => {
    try {
      if (!isConfigField(field)) {
        throw new Error(
          `Unknown setting '${field}'. Known settings: ${CONFIG_FIELDS.join(", ")}`,
        );
      }

      const updated = await new ConfigService(prisma).updateConfig({
        [field]: coerce(field, value),
      } as ConfigUpdate);

      console.log(
        `${chalk.green("✔")} ${chalk.bold(field)} = ${String(updated[field])}`,
      );
      if (field === "dbSeedStrategy") {
        console.log(chalk.dim(`Valid values: ${SEED_STRATEGIES.join(", ")}`));
      }
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
