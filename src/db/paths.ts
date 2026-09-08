import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where DevFlow keeps its own state.
 *
 * `DEVFLOW_HOME` wins outright. Otherwise `XDG_DATA_HOME/devflow` when that
 * variable is set (Linux convention), else `~/.devflow`.
 */
export function devflowHome(): string {
  const explicit = process.env.DEVFLOW_HOME?.trim();
  if (explicit) return explicit;

  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "devflow");

  return join(homedir(), ".devflow");
}

/** The SQLite file holding projects, environments, ports and config. */
export function databaseFile(): string {
  return join(devflowHome(), "devflow.db");
}

/**
 * The `DATABASE_URL` the Prisma client connects with. An explicit
 * `DATABASE_URL` in the environment wins, so a test run can point elsewhere.
 */
export function databaseUrl(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  return `file:${databaseFile()}`;
}
