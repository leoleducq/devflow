import chalk from "chalk";
import ora from "ora";
import type { Ora } from "ora";
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
 * Report a failure the way the caller asked for it, then exit non-zero. Every
 * command ends here, so the coded object on stderr is the single shape a JSON
 * caller has to handle.
 */
export const failCommand = (error: unknown, json?: boolean): never => {
  if (json) printJsonError(error);
  else
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
  process.exit(1);
};

/**
 * A spinner that draws nothing in JSON mode. Progress on stdout would corrupt
 * the document; progress on stderr would still surprise a caller reading both.
 */
export const quietSpinner = (text: string, json?: boolean): Ora =>
  ora({ text, isSilent: !!json }).start();

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
