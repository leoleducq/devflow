import { execa } from "execa";

export type CheckLevel = "ok" | "warn" | "fail";

export type Check = {
  name: string;
  level: CheckLevel;
  detail: string;
  /** What to do about it, shown only when the check is not ok. */
  hint?: string;
};

/** Path of an executable on PATH, or null when it is not installed. */
export async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execa("which", [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** First line of `<command> --version`, or null when it cannot be read. */
export async function versionOf(
  command: string,
  args: string[] = ["--version"],
): Promise<string | null> {
  try {
    const { stdout } = await execa(command, args);
    return stdout.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * A tool DevFlow needs. `required` tools make `doctor` fail; the others only
 * warn, because the commands that use them are optional.
 */
export async function checkTool(options: {
  command: string;
  label?: string;
  required: boolean;
  versionArgs?: string[];
  hint: string;
}): Promise<Check> {
  const { command, required, versionArgs, hint } = options;
  const name = options.label ?? command;

  if (!(await which(command))) {
    return {
      name,
      level: required ? "fail" : "warn",
      detail: "not found on PATH",
      hint,
    };
  }

  // Some tools print nothing useful for --version; being on PATH is enough.
  const version = await versionOf(command, versionArgs);
  return { name, level: "ok", detail: version || "installed" };
}
