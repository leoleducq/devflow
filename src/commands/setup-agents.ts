import { Command } from "commander";
import { colors } from "../lib/colors.js";
import * as prompts from "../lib/interactive.js";
import { AgentSkillsService } from "../services/agent-skills-service.js";
import type {
  SkillOutcome,
  SkillScope,
  SyncOptions,
} from "../services/agent-skills-service.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { printTable } from "../lib/table.js";
import { version } from "../lib/version.js";
import { DevflowError } from "../lib/errors.js";

/**
 * `--status` reports, it does not act: a row that says "outdated" has to look
 * like a warning there, while the same row after a write is a success.
 */
const symbol = (outcome: SkillOutcome, mode: "status" | "write"): string => {
  if (outcome.action === "skipped") return colors.dim("·");
  if (outcome.action === "up-to-date") return colors.green("✔");
  return mode === "status" ? colors.yellow("!") : colors.green("✔");
};

/** What each outcome reads as in the table, per mode. */
const describe = (outcome: SkillOutcome, mode: "status" | "write"): string => {
  switch (outcome.action) {
    case "up-to-date":
      return colors.dim("current");
    case "installed":
      return mode === "status" ? colors.yellow("not installed") : "installed";
    case "updated": {
      const from = outcome.installedVersion;
      const drift = from ? `${from} → ${version()}` : `→ ${version()}`;
      return mode === "status"
        ? colors.yellow(`outdated (${drift})`)
        : `updated (${drift})`;
    }
    case "removed":
      return "removed";
    case "skipped":
      return colors.dim(outcome.reason ?? "skipped");
  }
};

const table = (outcomes: SkillOutcome[], mode: "status" | "write"): void => {
  console.log();
  printTable(
    outcomes.map(outcome => [
      symbol(outcome, mode),
      colors.bold(outcome.label),
      describe(outcome, mode),
      outcome.action === "skipped" ? "" : colors.dim(outcome.path),
    ]),
  );
  console.log();
};

/** Directories a run would create or rewrite, for the confirmation prompt. */
const pending = (outcomes: SkillOutcome[]): SkillOutcome[] =>
  outcomes.filter(o => o.action === "installed" || o.action === "updated");

/**
 * `devflow setup-agents`: teach every coding agent on this machine how to
 * drive DevFlow, by installing the shipped SKILL.md into each agent's global
 * skills directory.
 *
 * Detection is by directory, never by assumption: an agent that is not set up
 * is skipped rather than handed a configuration directory it never asked for.
 * Nothing runs at install time — a postinstall script writing to $HOME is the
 * signature of npm malware, not of a good citizen — so this command is the
 * one explicit step, and it asks before writing.
 */
export const setupAgentsCommand = new Command()
  .name("setup-agents")
  .description(
    "Install the DevFlow skill into the coding agents on this machine",
  )
  .option(
    "--scope <scope>",
    "user (this machine) or project (this checkout's .agents/skills)",
    "user",
  )
  .option("--status", "Report what is installed, writing nothing")
  .option("--all", "Install into every known agent, even the absent ones")
  .option("--uninstall", "Remove the skill DevFlow installed")
  .option("--dry-run", "Report what would change without writing")
  .option("--only <agents>", "Comma-separated agent ids")
  .option("-y, --yes", "Do not ask before writing")
  .option("--json", "Machine-readable output")
  .action(async options => {
    try {
      const scope = String(options.scope) as SkillScope;
      if (scope !== "user" && scope !== "project") {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--scope expects 'user' or 'project', got '${scope}'`,
        );
      }

      const request: SyncOptions = {
        scope,
        projectRoot: process.cwd(),
        all: options.all,
        dryRun: options.dryRun,
        only: options.only
          ? String(options.only)
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [],
      };

      const service = new AgentSkillsService(version());

      if (options.status) {
        const outcomes = await service.status(request);
        if (options.json) printJson({ version: version(), scope, outcomes });
        else table(outcomes, "status");
        return;
      }

      if (options.uninstall) {
        const outcomes = await service.uninstall(request);
        finish(outcomes, options, { verb: "Removed", scope });
        return;
      }

      // Ask first, on the real plan: a preview run costs nothing and makes
      // the prompt name the exact files rather than a vague "some agents".
      //
      // Writing into someone's home directory without consent is the one
      // thing this command must never do, so when it cannot ask — a pipe, CI
      // — it refuses and names --yes instead of assuming agreement.
      if (!options.yes && !options.dryRun && !options.json) {
        if (!prompts.canPrompt()) {
          throw new DevflowError(
            "CONFIRMATION_REQUIRED",
            "setup-agents writes into your home directory; pass --yes to confirm, or --dry-run to see what it would write",
          );
        }
        const preview = pending(
          await service.install({ ...request, dryRun: true }),
        );
        if (preview.length === 0) {
          table(await service.status(request), "status");
          console.log(colors.green("Every agent already has the skill."));
          return;
        }
        console.log();
        console.log(colors.bold(`DevFlow ${version()} — skill to install:`));
        for (const outcome of preview) console.log(`  ${outcome.path}`);
        console.log();
        const confirm = await prompts.confirm({
          message: `Write ${preview.length} file(s)?`,
          initialValue: true,
        });
        if (!confirm) {
          console.log(colors.yellow("Cancelled"));
          return;
        }
      }

      finish(await service.install(request), options, {
        verb: "Updated",
        scope,
      });
    } catch (error) {
      failCommand(error, options.json);
    }
  });

/** Report the result of a write, in whichever form was asked for. */
function finish(
  outcomes: SkillOutcome[],
  options: { json?: boolean; dryRun?: boolean; all?: boolean },
  context: { verb: string; scope: SkillScope },
): void {
  if (options.json) {
    printJson({
      version: version(),
      scope: context.scope,
      dryRun: !!options.dryRun,
      outcomes,
    });
    return;
  }

  table(outcomes, "write");
  const changed = outcomes.filter(
    o => o.action === "installed" || o.action === "updated",
  ).length;
  const removed = outcomes.filter(o => o.action === "removed").length;
  const skipped = outcomes.filter(o => o.action === "skipped").length;

  if (options.dryRun) {
    console.log(colors.dim("--dry-run: nothing was written."));
    return;
  }
  console.log(
    colors.green(
      `${context.verb} ${context.verb === "Removed" ? removed : changed} location(s).`,
    ),
  );
  if (skipped > 0 && !options.all && context.verb !== "Removed") {
    console.log(
      colors.dim(
        "Agents that are not installed were skipped; --all writes to them anyway.",
      ),
    );
  }
  if (changed > 0) {
    console.log(
      colors.dim("Start a new agent session for it to pick the skill up."),
    );
  }
}
