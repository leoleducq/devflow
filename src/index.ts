import { Command } from "commander";
import { colors } from "./lib/colors.js";
import { prisma, ensureDatabase } from "./db/index.js";
import { ConfigService } from "./services/index.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { configCommand } from "./commands/config.js";
import { createCommand } from "./commands/create.js";
import { listCommand } from "./commands/list.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { destroyCommand } from "./commands/destroy.js";
import { runCommand } from "./commands/run.js";
import { projectCommand } from "./commands/project.js";
import { studioCommand } from "./commands/studio.js";
import { activateCommand } from "./commands/activate.js";
import { provisionCommand } from "./commands/provision.js";
import { teardownCommand } from "./commands/teardown.js";
import { proxyCommand } from "./commands/proxy.js";
import { herdrCommand } from "./commands/herdr.js";
import { killZombiesCommand } from "./commands/kill-zombies.js";
import { dbCommand } from "./commands/db.js";
import { envFilesCommand } from "./commands/env-files.js";
import { skillCommand } from "./commands/skill.js";
import { setupAgentsCommand } from "./commands/setup-agents.js";
import { completionCommand } from "./commands/completion.js";
import { version } from "./lib/version.js";
import { skillIsInstalled } from "./lib/skill-presence.js";
import { printHumanError } from "./lib/json-output.js";

const program = new Command();

/**
 * Most of DevFlow's users are coding agents, and most of them arrive with no
 * skill installed and nothing but `--help` to go on. Three lines there cost a
 * human nothing and save an agent a dozen exploratory invocations.
 *
 * Dropped once the skill is installed somewhere on this machine: an agent
 * that already has the full instructions does not need to be told twice, and
 * the advice is stale the moment it is followed.
 */
const agentFooter = (): string =>
  skillIsInstalled()
    ? ""
    : [
        "",
        "Are you an AI agent? Run `devflow skill` to read the DevFlow skill,",
        "or `devflow setup-agents` to install it for every agent on this machine.",
        "Machine-readable output: add --json to any command that returns data.",
      ].join("\n");

/**
 * Twenty-one commands in one alphabetical list tell you nothing about which
 * one to reach for. Grouped by what the user is trying to do, the same list
 * answers "how do I start?" and "what do I run every day?" without reading
 * every description.
 *
 * commander sorts its own command list, so the groups are printed as help
 * text and the built-in list is suppressed.
 */
const COMMAND_GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    "Setting up",
    [
      ["init", "Register the project in this directory"],
      ["doctor", "Check prerequisites, the database and the projects"],
      ["setup-agents", "Install the DevFlow skill for the coding agents here"],
      ["skill", "Print the DevFlow agent skill"],
    ],
  ],
  [
    "Every day",
    [
      ["run", "Run this environment's dev servers"],
      ["list", "List environments (alias: ls)"],
      ["db", "Open lazysql on this environment's database"],
      ["studio", "Open Prisma Studio on it"],
    ],
  ],
  [
    "Environments",
    [
      ["create", "New worktree, ports, database and deps for a branch"],
      ["provision", "Turn an existing checkout into an environment"],
      ["start", "Start a stopped environment"],
      ["stop", "Stop it, keeping everything"],
      ["teardown", "Release its database and ports, keep the checkout"],
      ["destroy", "Remove the worktree and the database"],
      ["env-files", "Regenerate its .env files"],
      ["activate", "Point the port proxies at it"],
    ],
  ],
  [
    "Projects and config",
    [
      ["project", "Register, inspect and configure projects"],
      ["config", "Read and change DevFlow's global settings"],
    ],
  ],
  [
    "Plumbing",
    [
      ["proxy", "Forward original app ports to the active environment"],
      ["herdr", "herdr integration helpers"],
      ["kill-zombies", "Kill orphaned dev servers"],
      ["completion", "Print a shell completion script"],
    ],
  ],
];

const groupedCommands = (): string => {
  const width = Math.max(
    ...COMMAND_GROUPS.flatMap(([, rows]) => rows.map(([name]) => name.length)),
  );
  return COMMAND_GROUPS.map(
    ([title, rows]) =>
      `${colors.bold(title)}\n` +
      rows
        .map(
          ([name, description]) =>
            `  ${name.padEnd(width)}  ${colors.dim(description)}`,
        )
        .join("\n"),
  ).join("\n\n");
};

program
  .name("devflow")
  .description(
    "Environments for git worktrees: database, ports, .env files, dev servers",
  )
  .version(version())
  // The grouped list replaces commander's flat one, which would otherwise
  // print all 21 commands a second time.
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText(
    "after",
    () =>
      `\n${groupedCommands()}\n\nRun \`devflow <command> --help\` for a command's options.${agentFooter()}`,
  );

/**
 * Nothing else creates the database, so every command starts by making sure
 * ~/.devflow exists, its schema is current, and the config row is there.
 */
program.hook("preAction", async () => {
  await ensureDatabase(prisma);
  await new ConfigService(prisma).getOrCreateConfig();
});

program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(configCommand);
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(destroyCommand);
program.addCommand(runCommand);
program.addCommand(projectCommand);
program.addCommand(studioCommand);
program.addCommand(activateCommand);
program.addCommand(provisionCommand);
program.addCommand(teardownCommand);
program.addCommand(proxyCommand);
program.addCommand(herdrCommand);
program.addCommand(killZombiesCommand);
program.addCommand(dbCommand);
program.addCommand(envFilesCommand);
program.addCommand(skillCommand);
program.addCommand(setupAgentsCommand);
program.addCommand(completionCommand);

program.on("command:*", () => {
  console.error(colors.red(`Invalid command: ${program.args.join(" ")}`));
  console.log(colors.dim("See --help for a list of available commands"));
  process.exit(1);
});

// Anything a command let escape lands here, and is rendered the same way a
// command's own failure would be.
program.parseAsync().catch((error: unknown) => {
  printHumanError(error);
  process.exit(1);
});
