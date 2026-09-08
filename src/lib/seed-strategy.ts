import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { devflowHome } from "../db/paths.js";
import { DevflowError } from "./errors.js";

/**
 * The `--seed` flag, in one place.
 *
 * Three strategies, spelled the way a person types them rather than the way
 * they are stored: `copy-main` dumps the project's source database,
 * `fresh` runs the migrations onto an empty one, and `snapshot:<name>`
 * restores a dump `devflow db snapshot` wrote earlier.
 *
 * The snapshot name has to survive the whole trip — the flag parses to
 * "SNAPSHOT", but a strategy with no path restores nothing — so the name and
 * the strategy are resolved together and travel together.
 */

export type SeedStrategy = "COPY_MAIN" | "FRESH_MIGRATE" | "SNAPSHOT";

export type SeedChoice = {
  strategy: SeedStrategy;
  /** Absolute path of the dump to restore, for SNAPSHOT only. */
  snapshotPath?: string;
};

const NAMED: Record<string, SeedStrategy> = {
  "copy-main": "COPY_MAIN",
  copy_main: "COPY_MAIN",
  fresh: "FRESH_MIGRATE",
  "fresh-migrate": "FRESH_MIGRATE",
};

/**
 * Where a snapshot lives. A bare name is DevFlow's own store, so it can be
 * referred to from any project; anything that looks like a path is taken as
 * one, so a dump can be committed next to the code that needs it.
 */
export const snapshotPath = (nameOrPath: string): string =>
  isAbsolute(nameOrPath) || nameOrPath.includes("/")
    ? resolve(nameOrPath)
    : join(devflowHome(), "snapshots", `${nameOrPath}.sql`);

/** The directory `devflow db snapshot` writes bare names into. */
export const snapshotDir = (): string => join(devflowHome(), "snapshots");

/**
 * Parse a `--seed` value, or fail naming what is accepted.
 *
 * A named snapshot is checked here rather than at the seed step, which is the
 * last of six: being told the dump does not exist after a container has been
 * created and the dependency install has run is a five-minute way to learn about a
 * typo.
 */
export async function parseSeedOption(
  value: string | undefined,
): Promise<SeedChoice | undefined> {
  if (!value) return undefined;

  const named = NAMED[value.toLowerCase()];
  if (named) return { strategy: named };

  if (value.toLowerCase().startsWith("snapshot:")) {
    const name = value.slice("snapshot:".length).trim();
    if (!name) {
      throw new DevflowError(
        "INVALID_ARGUMENT",
        "--seed snapshot: needs a name, e.g. --seed snapshot:before-migration",
      );
    }
    const path = snapshotPath(name);
    if (!existsSync(path)) {
      throw new DevflowError(
        "INVALID_ARGUMENT",
        `No snapshot at ${path}. List the ones you have with \`devflow db snapshots\`, or take one with \`devflow db snapshot ${name}\`.`,
      );
    }
    return { strategy: "SNAPSHOT", snapshotPath: path };
  }

  throw new DevflowError(
    "INVALID_ARGUMENT",
    `Unknown seed strategy '${value}'. Use copy-main, fresh, or snapshot:<name>.`,
  );
}
