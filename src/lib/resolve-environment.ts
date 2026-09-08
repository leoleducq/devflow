import { execa } from "execa";
import { EnvironmentService } from "../services/index.js";
import { prisma } from "../db/index.js";
import { DevflowError } from "./errors.js";

/**
 * The environment a command targets: by name when given, else the one whose
 * worktree contains `cwd`. Inside a herdr pane the cwd is enough, which is
 * what makes `devflow run` work with no argument.
 */
export async function resolveEnvironment(options: {
  name?: string;
  cwd?: string;
}) {
  const service = new EnvironmentService(prisma);
  if (options.name) {
    const env = await service.getEnvironmentByName(options.name);
    if (!env)
      throw new DevflowError(
        "ENVIRONMENT_NOT_FOUND",
        `Environment '${options.name}' not found`,
      );
    return env;
  }

  // Match the path itself first: on teardown the directory is already gone,
  // so git cannot tell us anything about it any more.
  const dir = options.cwd ?? process.cwd();
  const env =
    (await service.findByWorktreePath(dir)) ??
    (await (async () => {
      const checkout = await gitToplevel(dir);
      return checkout ? service.findByWorktreePath(checkout) : null;
    })());
  if (!env) {
    throw new DevflowError(
      "NOT_AN_ENVIRONMENT",
      `${options.cwd ?? process.cwd()} is not inside a DevFlow environment. Pass a name, or run \`devflow provision\` here first.`,
    );
  }
  return env;
}

/** Root of the checkout containing `dir`, or null outside any repository. */
export async function gitToplevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
