import { resolve } from "node:path";
import { homedir } from "node:os";
import fs from "fs-extra";
import type { Prisma, Project } from "../db/types.js";
import { toJsonArray, parseJsonArray, parseJsonObject } from "./json-serialization.js";

/**
 * How one editable Project column maps to a `--flag` and back.
 *
 * `parse` turns the string the user typed into the value the column stores,
 * throwing on anything invalid. `display` turns it back into something worth
 * reading. Keeping both here is what lets `project set`, `project get` and the
 * `init` wizard agree without repeating themselves.
 */
type FieldSpec = {
  /** Long option, without the leading dashes. */
  flag: string;
  placeholder: string;
  description: string;
  parse: (raw: string) => Promise<string> | string;
  display?: (value: string | null) => string;
};

const asJsonArray = (raw: string): string =>
  toJsonArray(
    raw
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  );

const showJsonArray = (value: string | null): string => {
  const items = parseJsonArray(value);
  return items.length > 0 ? items.join(", ") : "-";
};

const showJsonObject = (value: string | null): string => {
  const parsed = parseJsonObject<Record<string, unknown>>(value);
  if (!parsed) return "-";
  const entries = Object.entries(parsed);
  return entries.length > 0
    ? entries.map(([k, v]) => `${k}=${String(v)}`).join(", ")
    : "-";
};

/** `web:3000,api:3005` and raw JSON both work; the column stores JSON. */
function parseAppPorts(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJsonObject<Record<string, unknown>>(trimmed);
    if (!parsed) throw new Error("appPorts: invalid JSON");
    return JSON.stringify(parsed);
  }

  const ports: Record<string, number> = {};
  for (const pair of trimmed.split(",").map(s => s.trim()).filter(Boolean)) {
    const [app, value] = pair.split(":").map(s => s?.trim());
    const port = Number(value);
    if (!app || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `appPorts: expected 'app:port' pairs, got '${pair}' (e.g. web:3000,api:3005)`,
      );
    }
    ports[app] = port;
  }
  return JSON.stringify(ports);
}

/** `web=next dev,api=tsx watch src` and raw JSON both work. */
function parseDevCommands(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJsonObject<Record<string, unknown>>(trimmed);
    if (!parsed) throw new Error("devCommands: invalid JSON");
    return JSON.stringify(parsed);
  }

  const commands: Record<string, string> = {};
  for (const pair of trimmed.split(",").map(s => s.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    const app = at === -1 ? "" : pair.slice(0, at).trim();
    const command = at === -1 ? "" : pair.slice(at + 1).trim();
    if (!app || !command) {
      throw new Error(
        `devCommands: expected 'app=command' pairs, got '${pair}' (e.g. web=next dev)`,
      );
    }
    commands[app] = command;
  }
  return JSON.stringify(commands);
}

async function parsePath(raw: string): Promise<string> {
  const expanded = raw.startsWith("~") ? raw.replace("~", homedir()) : raw;
  const absolute = resolve(expanded);
  if (!(await fs.pathExists(absolute))) {
    throw new Error(`path: ${absolute} does not exist`);
  }
  return absolute;
}

const SEED_STRATEGIES = ["COPY_MAIN", "FRESH_MIGRATE", "SNAPSHOT"];

function parseSeed(raw: string): string {
  const value = raw.trim().toUpperCase().replace(/-/g, "_");
  const alias: Record<string, string> = {
    "COPY_MAIN": "COPY_MAIN",
    FRESH: "FRESH_MIGRATE",
    FRESH_MIGRATE: "FRESH_MIGRATE",
    SNAPSHOT: "SNAPSHOT",
  };
  const resolved = alias[value];
  if (!resolved) {
    throw new Error(
      `defaultSeed: expected one of ${SEED_STRATEGIES.join(", ")}, got '${raw}'`,
    );
  }
  return resolved;
}

function parseNonEmpty(label: string) {
  return (raw: string): string => {
    const value = raw.trim();
    if (!value) throw new Error(`${label}: must not be empty`);
    return value;
  };
}

/** Every Project column `devflow project set` can write. */
export const PROJECT_FIELDS = {
  name: {
    flag: "name",
    placeholder: "<name>",
    description: "Rename the project",
    parse: parseNonEmpty("name"),
  },
  path: {
    flag: "path",
    placeholder: "<dir>",
    description: "Path to the main checkout",
    parse: parsePath,
  },
  apps: {
    flag: "apps",
    placeholder: "<a,b>",
    description: "Every app the repo contains",
    parse: asJsonArray,
    display: showJsonArray,
  },
  defaultApps: {
    flag: "default-apps",
    placeholder: "<a,b>",
    description: "Apps `devflow run` starts when none are named",
    parse: asJsonArray,
    display: showJsonArray,
  },
  defaultBaseBranch: {
    flag: "default-base-branch",
    placeholder: "<branch>",
    description: "Branch new environments are cut from",
    parse: parseNonEmpty("defaultBaseBranch"),
  },
  defaultSeed: {
    flag: "default-seed",
    placeholder: "<strategy>",
    description: `Seed strategy: ${SEED_STRATEGIES.join(" | ")}`,
    parse: parseSeed,
  },
  sourceDatabaseUrl: {
    flag: "source-database-url",
    placeholder: "<url>",
    description: "Database COPY_MAIN dumps from",
    parse: parseNonEmpty("sourceDatabaseUrl"),
  },
  dbEnvVarName: {
    flag: "db-env-var-name",
    placeholder: "<VAR>",
    description: "Env var holding the connection string",
    parse: parseNonEmpty("dbEnvVarName"),
  },
  dbDockerImage: {
    flag: "db-docker-image",
    placeholder: "<image>",
    description: "Postgres image for environment databases",
    parse: parseNonEmpty("dbDockerImage"),
  },
  devCommands: {
    flag: "dev-commands",
    placeholder: "<app=cmd,…>",
    description: "Dev command per app",
    parse: parseDevCommands,
    display: showJsonObject,
  },
  appPorts: {
    flag: "app-ports",
    placeholder: "<app:port,…>",
    description: "Port each app uses in the main checkout",
    parse: parseAppPorts,
    display: showJsonObject,
  },
  linearApiKey: {
    flag: "linear-api-key",
    placeholder: "<key>",
    description: "Linear personal API key",
    parse: parseNonEmpty("linearApiKey"),
    display: value => (value ? "set" : "-"),
  },
  linearTeamId: {
    flag: "linear-team-id",
    placeholder: "<id>",
    description: "Linear team the issues come from",
    parse: parseNonEmpty("linearTeamId"),
  },
  linearProjectId: {
    flag: "linear-project-id",
    placeholder: "<id>",
    description: "Restrict issues to one Linear project",
    parse: parseNonEmpty("linearProjectId"),
  },
  linearExcludeStates: {
    flag: "linear-exclude-states",
    placeholder: "<a,b>",
    description: "Workflow states to hide from `project issues`",
    parse: asJsonArray,
    display: showJsonArray,
  },
  linearFilterLabels: {
    flag: "linear-filter-labels",
    placeholder: "<a,b>",
    description: "Only show issues carrying these labels",
    parse: asJsonArray,
    display: showJsonArray,
  },
} as const satisfies Record<string, FieldSpec>;

export type ProjectField = keyof typeof PROJECT_FIELDS;

/** Commander turns `--db-env-var-name` into `dbEnvVarName`; map it back. */
export const FIELD_BY_OPTION_KEY = new Map<string, ProjectField>(
  (Object.keys(PROJECT_FIELDS) as ProjectField[]).map(field => [
    PROJECT_FIELDS[field].flag.replace(/-([a-z])/g, (_, c: string) =>
      c.toUpperCase(),
    ),
    field,
  ]),
);

/**
 * Validate and convert the `--flag value` pairs commander collected into the
 * Prisma update payload. Rejects the call when no field was given, so
 * `project set myapp` cannot silently do nothing.
 */
export async function buildProjectUpdate(
  options: Record<string, unknown>,
): Promise<Prisma.ProjectUpdateInput> {
  const update: Record<string, string> = {};

  for (const [key, raw] of Object.entries(options)) {
    const field = FIELD_BY_OPTION_KEY.get(key);
    if (!field || typeof raw !== "string") continue;
    update[field] = await PROJECT_FIELDS[field].parse(raw);
  }

  if (Object.keys(update).length === 0) {
    throw new Error(
      "Nothing to change. Pass at least one field, e.g. --app-ports web:3000,api:3005",
    );
  }

  return update;
}

/** The project as `project get` prints it: every editable field, readable. */
export function describeProject(project: Project): Array<[string, string]> {
  return (Object.keys(PROJECT_FIELDS) as ProjectField[]).map(field => {
    const spec = PROJECT_FIELDS[field];
    const value = project[field];
    const text =
      "display" in spec && spec.display
        ? spec.display(value as string | null)
        : ((value as string | null) ?? "-");
    return [field, text];
  });
}
