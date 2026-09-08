import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";

export const startCommand = new Command()
  .name("start")
  .description("Start an environment (this checkout by default)")
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .action(async (envName: string | undefined) => {
    const spinner = ora("Starting environment…").start();
    try {
      const env = await resolveEnvironment({ name: envName });
      spinner.text = `Starting ${env.name}…`;
      await new EnvironmentService(prisma).startEnvironment(env.id);
      spinner.succeed(chalk.green(`${env.name} started`));
    } catch (error) {
      spinner.fail(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
