import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { checkTool, which } from "../lib/checks.js";
import type { Check } from "../lib/checks.js";
import {
  inspectForRegistration,
  registerProject,
  registrationAnswers,
  REGISTRATION_FLAGS,
} from "../lib/register-project.js";
import { skillIsInstalled } from "../lib/skill-presence.js";
import {
  failCommand,
  printJson,
  redact,
  startSpinner,
} from "../lib/json-output.js";
import { table as tableLines } from "../lib/table.js";

/**
 * Only what `init` itself needs. The full sweep — orphaned containers, the
 * state of every registered project — belongs to `devflow doctor`.
 */
async function prerequisites(): Promise<Check[]> {
  const checks: Check[] = [
    await checkTool({
      command: "git",
      required: true,
      hint: "DevFlow provisions git worktrees; install git first",
    }),
    await checkTool({
      command: "pnpm",
      required: true,
      hint: "DevFlow installs worktree dependencies and runs dev servers with pnpm; install it from https://pnpm.io/installation",
    }),
  ];

  if (await which("docker")) {
    checks.push({ name: "docker", level: "ok", detail: "installed" });
  } else {
    checks.push({
      name: "docker",
      level: "warn",
      detail: "not found on PATH",
      hint: "Environments need it for their Postgres; LITE environments work without it",
    });
  }

  return checks;
}

const SYMBOL = {
  ok: colors.green("✔"),
  warn: colors.yellow("!"),
  fail: colors.red("✘"),
} as const;

export const initCommand = new Command()
  .name("init")
  .description(
    "Set DevFlow up for the project in this directory: check prerequisites, detect it, register it",
  )
  .argument("[path]", "Project directory (default: current directory)")
  .option("-y, --yes", "Accept everything detected without prompting")
  .option("--json", "Machine-readable output");

// The wizard's questions, also available as flags: `devflow init` has to work
// from a script or an agent, not only from a terminal.
for (const [flag, description] of REGISTRATION_FLAGS) {
  initCommand.option(flag, description);
}

initCommand
  .addHelpText(
    "after",
    `
Examples:
  $ devflow init                        detect and register, asking to confirm
  $ devflow init -y                     accept everything detected
  $ devflow init --name api --apps web,api --json`,
  )
  .action(async (pathArg: string | undefined, options) => {
    try {
      if (options.json) {
        // A JSON caller wants the project row, not a setup report.
        const registration = await inspectForRegistration(
          pathArg ?? process.cwd(),
        );
        const project = await registerProject(registration, {
          interactive: false,
          json: true,
          answers: registrationAnswers(options),
        });
        printJson(redact(project));
        return;
      }

      console.log();
      console.log(colors.bold.underline("Prerequisites"));
      const checks = await prerequisites();
      const rendered = tableLines(
        checks.map(check => [
          SYMBOL[check.level],
          colors.bold(check.name),
          check.level === "ok" ? colors.dim(check.detail) : check.detail,
        ]),
        { indent: "  " },
      );
      checks.forEach((check, i) => {
        console.log(rendered[i]);
        if (check.hint && check.level !== "ok") {
          console.log(`    ${colors.dim(`→ ${check.hint}`)}`);
        }
      });

      if (checks.some(c => c.level === "fail")) {
        console.log();
        console.log(
          colors.red(
            "Install the missing tools above, then run `devflow init` again.",
          ),
        );
        process.exit(1);
      }

      const spinner = startSpinner("Inspecting the project…");
      const registration = await inspectForRegistration(
        pathArg ?? process.cwd(),
      );
      spinner.stop();

      const project = await registerProject(registration, {
        interactive: !options.yes,
        answers: registrationAnswers(options),
      });

      console.log();
      console.log(
        `${colors.green("✔")} ${colors.bold(project.name)} is registered.`,
      );
      console.log();
      console.log(colors.bold("Next"));
      console.log(
        `  ${colors.dim("provision this checkout")}   devflow provision`,
      );
      console.log(`  ${colors.dim("run its dev servers")}       devflow run`);
      console.log(
        `  ${colors.dim("review what was detected")}  devflow project get ${project.name}`,
      );
      console.log(
        `  ${colors.dim("connect Linear")}            devflow project linear ${project.name}`,
      );
      console.log(`  ${colors.dim("check the whole setup")}     devflow doctor`);
      console.log();

      // Offered, never done: installing files into someone's home directory
      // is their decision, and `setup-agents` asks again before it writes.
      if (!skillIsInstalled()) {
        console.log(colors.bold("Working with coding agents?"));
        console.log(
          `  ${colors.dim("teach every agent on this machine")}  devflow setup-agents`,
        );
        console.log(
          `  ${colors.dim("or just read the skill yourself")}    devflow skill`,
        );
        console.log();
      }
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
