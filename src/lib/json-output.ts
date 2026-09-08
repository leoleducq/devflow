import * as clack from "@clack/prompts";
import { colors } from "./colors.js";
import { errorCode } from "./errors.js";

/**
 * Machine-readable output, for the agents that drive this CLI.
 *
 * The contract every `--json` command honours: exactly one JSON value on
 * stdout and nothing else — no spinner, no progress, no human summary. Errors
 * go to stderr as `{"ok": false, "error": {"code", "message"}}` with a
 * non-zero exit code, so a caller can parse stdout unconditionally and read
 * the status code for success.
 */

/** Print one JSON value on stdout. The only thing a `--json` run writes. */
export const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

/**
 * Print the failure on stderr in the shape every command uses. `code` is the
 * stable half: a caller branches on it to tell "this checkout is not an
 * environment" from "Docker is not running" without parsing prose.
 */
export const printJsonError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code: errorCode(error), message } })}\n`,
  );
};

/**
 * The one place a failure becomes text for a person to read.
 *
 * Every command routes here, so an error looks the same wherever it came
 * from, and the code — the thing that tells "install Docker" apart from
 * "pass --yes" — is never dropped just because the caller wanted prose.
 */
export const printHumanError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  process.stderr.write(
    `${colors.red("✘")} ${message}${code === "UNKNOWN" ? "" : ` ${colors.dim(`[${code}]`)}`}\n`,
  );
};

/**
 * Report a failure the way the caller asked for it, then exit non-zero. Every
 * command ends here, so the coded object on stderr is the single shape a JSON
 * caller has to handle.
 */
export const failCommand = (error: unknown, json?: boolean): never => {
  if (json) printJsonError(error);
  else printHumanError(error);
  process.exit(1);
};

/**
 * A single-step spinner that draws nothing in JSON mode.
 *
 * Progress on stdout would corrupt the document; progress on stderr would
 * still surprise a caller reading both. Multi-step work uses the task list in
 * `task-list.ts` instead — this is for the operations that really are one
 * opaque wait.
 *
 * clack's spinner backs it rather than ora, so the wizards and the spinners
 * share one visual language, and it degrades to plain lines off a TTY where
 * ora would emit frames nobody redraws.
 */
export type Spinner = {
  start: (text?: string) => void;
  update: (text: string) => void;
  succeed: (text: string) => void;
  fail: (text: string) => void;
  stop: () => void;
};

export const quietSpinner = (text: string, json?: boolean): Spinner => {
  if (json) {
    return {
      start: () => {},
      update: () => {},
      succeed: () => {},
      fail: () => {},
      stop: () => {},
    };
  }

  // Off a TTY there is nothing to animate: print the milestones as lines so
  // a log keeps the sequence instead of a burst of escape codes.
  if (!process.stdout.isTTY || process.env.CI) {
    let current = text;
    return {
      start: (next?: string) => {
        current = next ?? current;
        console.log(colors.dim(`… ${current}`));
      },
      update: (next: string) => {
        current = next;
        console.log(colors.dim(`… ${current}`));
      },
      succeed: (message: string) =>
        console.log(`${colors.green("✔")} ${message}`),
      fail: (message: string) => console.log(`${colors.red("✘")} ${message}`),
      stop: () => {},
    };
  }

  const spinner = clack.spinner();
  let running = false;
  return {
    start: (next?: string) => {
      if (running) return;
      running = true;
      spinner.start(next ?? text);
    },
    update: (next: string) => {
      if (running) spinner.message(next);
    },
    succeed: (message: string) => {
      if (running) spinner.stop(`${colors.green("✔")} ${message}`);
      else console.log(`${colors.green("✔")} ${message}`);
      running = false;
    },
    fail: (message: string) => {
      if (running) spinner.error(`${colors.red("✘")} ${message}`);
      else console.log(`${colors.red("✘")} ${message}`);
      running = false;
    },
    stop: () => {
      if (running) spinner.stop("");
      running = false;
    },
  };
};

/** Start a spinner immediately, the way `ora(...).start()` used to read. */
export const startSpinner = (text: string, json?: boolean): Spinner => {
  const spinner = quietSpinner(text, json);
  spinner.start();
  return spinner;
};

/**
 * Secrets DevFlow stores for a project but must not hand to whoever asked for
 * JSON: an agent pipes this into a log as easily as into a parser.
 */
const REDACTED_KEYS = new Set([
  "linearApiKey",
  "password",
  "sourceDatabaseUrl",
]);

/**
 * Deep copy with the secret fields masked. Prisma rows come back with the
 * project relation attached, so redaction has to be recursive rather than a
 * field list at the top level.
 */
export const redact = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => redact(item)) as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      REDACTED_KEYS.has(key) && item !== null && item !== undefined
        ? "[redacted]"
        : redact(item);
  }
  return out as T;
};
