import chalk from "chalk";
import ora from "ora";
import { EnvironmentService, CREATE_ENV_STEPS } from "../services/index.js";
import type { CreateEnvStepId } from "../services/index.js";
import { prisma } from "../db/index.js";

const STEP_LABEL = Object.fromEntries(
  CREATE_ENV_STEPS.map(s => [s.id, s.label]),
) as Record<CreateEnvStepId, string>;

type Env = NonNullable<
  Awaited<ReturnType<EnvironmentService["getEnvironment"]>>
>;

/**
 * A LITE environment (the default when herdr creates a worktree) has no
 * ports, database or deps. Anything that needs them provisions first, so the
 * cost is paid on the first `devflow run`, not at creation.
 */
export async function ensureFull(env: Env): Promise<Env> {
  if (env.kind !== "LITE") return env;
  const service = new EnvironmentService(prisma);
  const spinner = ora(`Provisioning ${env.name} (first run)`).start();
  try {
    await service.promoteEnvironment(env.id, {}, event => {
      if (event.type === "step" && event.status === "start")
        spinner.text = STEP_LABEL[event.id] ?? event.id;
    });
    spinner.succeed(chalk.green(`${env.name} provisioned`));
  } catch (error) {
    spinner.fail(chalk.red("Provisioning failed"));
    throw error;
  }
  const full = await service.getEnvironment(env.id);
  if (!full) throw new Error(`Environment ${env.name} disappeared`);
  return full;
}
