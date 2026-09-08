/**
 * Failure codes an agent can branch on.
 *
 * A message is for a human to read; a caller deciding whether to retry, start
 * Docker or provision a checkout needs something stable. Codes are the stable
 * half of the JSON error shape, and messages stay free to be reworded.
 */
export type ErrorCode =
  | "NOT_AN_ENVIRONMENT"
  | "ENVIRONMENT_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "ENVIRONMENT_NOT_RUNNING"
  | "NO_DATABASE"
  | "DOCKER_UNAVAILABLE"
  | "TOOL_MISSING"
  | "INVALID_ARGUMENT"
  | "CONFIRMATION_REQUIRED"
  | "UNKNOWN";

/** An error DevFlow raised deliberately, carrying a code for JSON callers. */
export class DevflowError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DevflowError";
  }
}

/**
 * Patterns that classify the failures DevFlow does not raise itself — mostly
 * execa reporting a missing binary or a daemon that will not answer. Matching
 * on text is a last resort, so it is confined here rather than spread across
 * the commands.
 */
const PATTERNS: Array<[RegExp, ErrorCode]> = [
  [/cannot connect to the docker daemon|docker daemon is not running/i, "DOCKER_UNAVAILABLE"],
  [/\bENOENT\b.*\bdocker\b|spawn docker/i, "DOCKER_UNAVAILABLE"],
  [/\bENOENT\b|command not found|spawn \S+ ENOENT/i, "TOOL_MISSING"],
];

/** The code to report for any thrown value. */
export const errorCode = (error: unknown): ErrorCode => {
  if (error instanceof DevflowError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? "UNKNOWN";
};
