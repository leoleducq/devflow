import { Command } from "commander";
import { watch } from "node:fs";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { ProcessService, environmentLogFile } from "../services/index.js";
import type { LogEntry } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";

/**
 * `devflow logs`: what the dev servers printed.
 *
 * The desktop UI had a log pane per environment because its API held the
 * output in memory. Here the producer (`devflow run`, in one pane) and the
 * reader (an agent, in another) are different processes, so the output is
 * read back from the file `run` writes as it goes.
 *
 * `--errors` is the shortcut that matters for an agent: "why did it crash"
 * is stderr, and it is otherwise buried under a thousand lines of ready-in-
 * 340ms.
 */

/** One log line, painted so app and stream are readable at a glance. */
const render = (entry: LogEntry): string => {
  const text = entry.text.replace(/\n$/, "");
  const tag = colors.dim(`[${entry.app}]`);
  return text
    .split("\n")
    .map(line =>
      entry.stream === "stderr" ? `${tag} ${colors.red(line)}` : `${tag} ${line}`,
    )
    .join("\n");
};

export const logsCommand = new Command()
  .name("logs")
  .description(
    "Show what an environment's dev servers printed (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("-a, --app <app>", "Only this app's output (e.g. api, web)")
  .option("-e, --errors", "Only stderr — what crashed and why")
  .option("-n, --lines <n>", "How many lines to show", "200")
  .option("-f, --follow", "Keep printing as new output arrives")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow logs                    the last 200 lines of this environment
  $ devflow logs --app api -e       only the api's errors
  $ devflow logs -f                 follow, like tail -f
  $ devflow logs --json -n 50       the last 50 entries as JSON

Logs are written by \`devflow run\`; an environment that has never been run
has none.`,
  )
  .action(async (envName: string | undefined, options) => {
    try {
      const limit = Number(options.lines);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--lines expects a positive integer, got '${options.lines}'`,
        );
      }
      if (options.follow && options.json) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          "--follow streams forever, so it cannot produce a single JSON document. Drop one of --follow and --json.",
        );
      }

      const env = await resolveEnvironment({ name: envName });
      const processes = new ProcessService(prisma);
      const filters = {
        app: options.app as string | undefined,
        stream: options.errors ? ("stderr" as const) : undefined,
      };

      const entries = await processes.readLogFile(env.id, {
        ...filters,
        limit,
      });

      if (options.json) {
        printJson({ environment: env.name, logs: entries });
        return;
      }

      if (entries.length === 0 && !options.follow) {
        console.log(
          colors.yellow(
            options.errors
              ? `No errors recorded for ${env.name}`
              : `No output recorded for ${env.name}`,
          ),
        );
        console.log(
          colors.dim("Dev servers write their output while:"),
          colors.white(`devflow run ${env.name}`),
        );
        return;
      }

      for (const entry of entries) console.log(render(entry));

      if (!options.follow) return;

      // Follow by re-reading from the offset the file had when we printed:
      // the writer appends whole JSON lines, so a size-triggered re-read can
      // never split one. Simpler and more portable than a tail syscall, and
      // dev-server output is far too slow for the difference to matter.
      await prisma.$disconnect();
      let seen = entries.length;
      const drain = async () => {
        const all = await processes.readLogFile(env.id, filters);
        for (const entry of all.slice(seen)) console.log(render(entry));
        seen = Math.max(seen, all.length);
      };

      const file = environmentLogFile(env.id);
      try {
        watch(file, { persistent: true }, () => {
          void drain();
        });
      } catch {
        // The file does not exist yet: poll until `devflow run` creates it.
        setInterval(() => void drain(), 1000);
      }
      await new Promise(() => {});
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      if (!options.follow) await prisma.$disconnect();
    }
  });
