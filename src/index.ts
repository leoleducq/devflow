import { Command } from "commander";
import chalk from "chalk";
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
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("devflow")
  .description(
    "Environments for git worktrees: database, ports, .env files, dev servers",
  )
  .version(version());

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

program.on("command:*", () => {
  console.error(chalk.red(`Invalid command: ${program.args.join(" ")}`));
  console.log(chalk.dim("See --help for a list of available commands"));
  process.exit(1);
});

program.parseAsync().catch((error: unknown) => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
