import * as clack from "@clack/prompts";
import { DevflowError } from "./errors.js";

/**
 * The rule every prompt in DevFlow goes through.
 *
 * Most of this CLI's callers are coding agents and scripts, and no prompt
 * library fails safely for them. With stdin at EOF some libraries throw; with
 * stdin open but silent — a subprocess with an inherited pipe, which is what
 * an agent actually gives you — inquirer, @inquirer/prompts and
 * @clack/prompts all wait forever. A hung provisioning run is worse than a
 * failed one: nothing times out, nothing is logged, and the caller has no
 * error to branch on.
 *
 * So interactivity is decided before a prompt is ever constructed, and when
 * the answer is no the command fails immediately naming the flag that would
 * have supplied the answer.
 */

/** Why a run must not prompt, or null when prompting is fine. */
const nonInteractiveReason = (options: PromptContext): string | null => {
  if (options.json) return "--json";
  if (options.yes) return "--yes";
  if (process.env.CI) return "CI";
  if (!process.stdin.isTTY) return "stdin is not a TTY";
  if (!process.stdout.isTTY) return "stdout is not a TTY";
  return null;
};

export type PromptContext = {
  /** The command was asked for machine-readable output. */
  json?: boolean;
  /** The user asked for every question to be answered by its default. */
  yes?: boolean;
};

/** Whether this run may put a question on the terminal and wait for it. */
export const canPrompt = (context: PromptContext = {}): boolean =>
  nonInteractiveReason(context) === null;

/**
 * Refuse to prompt, explaining which flag to pass instead.
 *
 * `INPUT_REQUIRED` is the code a caller branches on: it means "the command is
 * fine, it simply needs this value up front", which is a different recovery
 * from a missing tool or an absent environment.
 */
export const requireInput = (
  what: string,
  flag: string,
  context: PromptContext = {},
): never => {
  const reason = nonInteractiveReason(context) ?? "not interactive";
  throw new DevflowError(
    "INPUT_REQUIRED",
    `${what} is required (${reason}, so DevFlow will not prompt). Pass ${flag}.`,
  );
};

/**
 * Read a value that may come from a flag, and only ask for it when it did
 * not. The single door every optional question goes through, so a new prompt
 * cannot be added without also being given a flag.
 */
export async function askFor<T>(options: {
  /** The value the user already supplied, if any. */
  provided: T | undefined | null;
  /** What is missing, for the error message. */
  what: string;
  /** The flag that supplies it without a prompt. */
  flag: string;
  /** Used when non-interactive rather than failing, when there is one. */
  fallback?: T;
  context?: PromptContext;
  ask: () => Promise<T>;
}): Promise<T> {
  const { provided, what, flag, fallback, context = {}, ask } = options;
  if (provided !== undefined && provided !== null && provided !== "")
    return provided;
  if (!canPrompt(context)) {
    if (fallback !== undefined) return fallback;
    return requireInput(what, flag, context);
  }
  return cancellable(await ask());
}

/**
 * Turn a Ctrl+C into a clean exit.
 *
 * clack returns a cancel symbol rather than throwing, so an unchecked prompt
 * silently yields that symbol as if it were an answer and the command carries
 * on with a nonsense value. Every prompt result passes through here.
 */
export function cancellable<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130); // 128 + SIGINT, what a shell expects from Ctrl+C.
  }
  return value as T;
}

/** A text question whose answer defaults to `initialValue` when left blank. */
export async function text(options: {
  message: string;
  initialValue?: string;
  placeholder?: string;
}): Promise<string> {
  const answer = cancellable(
    await clack.text({
      message: options.message,
      initialValue: options.initialValue,
      placeholder: options.placeholder,
      // clack treats an empty answer as undefined; the caller's default is
      // the point of showing one, so fill it back in.
      defaultValue: options.initialValue ?? "",
    }),
  );
  return answer ?? options.initialValue ?? "";
}

/** A masked question, for API keys and passwords. */
export async function password(message: string): Promise<string> {
  return cancellable(await clack.password({ message, mask: "*" }));
}

/** A yes/no question. */
export async function confirm(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  return cancellable(
    await clack.confirm({
      message: options.message,
      initialValue: options.initialValue ?? false,
    }),
  );
}

/**
 * A pick-one-from-a-list question. Values are strings — every list DevFlow
 * shows is a list of ids or keys — which is also what clack's option type
 * accepts without a cast.
 */
export async function select(options: {
  message: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  initialValue?: string;
}): Promise<string> {
  return cancellable(
    await clack.select({
      message: options.message,
      options: options.options,
      initialValue: options.initialValue,
    }),
  );
}

export { clack };
