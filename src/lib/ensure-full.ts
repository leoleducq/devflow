import { colors } from "./colors.js";
import { EnvironmentService, PROMOTE_ENV_STEPS } from "../services/index.js";
import { runSteps, renderMode } from "./task-list.js";
import { prisma } from "../db/index.js";

type Env = NonNullable<
  Awaited<ReturnType<EnvironmentService["getEnvironment"]>>
>;

/**
 * A LITE environment (the default when herdr creates a worktree) has no
 * ports, database or deps. Anything that needs them provisions first, so the
 * cost is paid on the first `devflow run`, not at creation.
 *
 * This is the moment a user is least expecting a wait — they asked to run
 * dev servers and got a five-minute provision — so it shows the same
 * checklist as `provision` rather than a single spinner: the wait is at
 * least legible, and the dependency install is visibly the reason for it.
 *
 * `quiet` silences the progress for callers whose stdout is a JSON document.
 */
export async function ensureFull(
  env: Env,
  options: { quiet?: boolean } = {},
): Promise<Env> {
  if (env.kind !== "LITE") return env;
  const service = new EnvironmentService(prisma);
  const mode = renderMode({ quiet: options.quiet });

  if (mode !== "silent") {
    console.log();
    console.log(colors.bold(`Provisioning ${env.name} (first run)`));
  }

  await runSteps({
    steps: PROMOTE_ENV_STEPS,
    mode,
    operation: onProgress =>
      service.promoteEnvironment(env.id, {}, onProgress),
  });

  if (mode !== "silent") {
    console.log(`${colors.green("✔")} ${env.name} provisioned`);
    console.log();
  }

  const full = await service.getEnvironment(env.id);
  if (!full) throw new Error(`Environment ${env.name} disappeared`);
  return full;
}
