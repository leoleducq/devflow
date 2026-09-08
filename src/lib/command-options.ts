import type { Command } from "commander";

/**
 * The options a subcommand actually received, parent flags included.
 *
 * commander lets a parent claim an option its subcommand declares too: with
 * `--json` on both `db` and `db query`, the parent takes it and the
 * subcommand's own value is never set, so `devflow db query … --json` would
 * silently print human text. Reading through the chain fixes that without
 * renaming anything, and keeps `--json` meaning the same thing at every
 * depth.
 *
 * Actions that use this take commander's `(…args, flags, command)` shape and
 * ignore `flags`, since it is the half-populated object this replaces.
 */
export const commandOptions = <T = Record<string, unknown>>(
  command: Command,
): T => command.optsWithGlobals() as T;
