import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./package-paths.js";

/**
 * The running DevFlow version, read from the package manifest rather than
 * duplicated in the source: `npm version` then only has one place to change,
 * and `--version`, the skill stamp and the JSON output can never disagree.
 */
export const version = (): string => {
  try {
    const manifest = readFileSync(join(packageRoot(), "package.json"), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};
