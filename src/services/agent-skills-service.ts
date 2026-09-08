import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { skillPath } from "../lib/package-paths.js";
import { DevflowError } from "../lib/errors.js";

/**
 * Installing the DevFlow skill into the coding agents on this machine.
 *
 * Every agent below reads *global* skills from its own directory, in the
 * Agent Skills layout: `<skills dir>/<skill name>/SKILL.md`. DevFlow writes
 * exactly one file per directory, `devflow/SKILL.md`, and touches nothing
 * else — these directories belong to the user.
 *
 * Several agents share `~/.agents/skills`; the installer resolves paths first
 * and writes each one once, so a machine with five of them gets one write and
 * one line of output for the lot.
 */

export type SkillScope = "user" | "project";

export type AgentTarget = {
  /** Stable id, also what `--only` matches on. */
  id: string;
  /** Shown in the report. */
  label: string;
  /**
   * Directory whose existence proves the agent is set up on this machine.
   * The skills directory itself is usually absent until a skill is installed,
   * so detection looks at the agent's configuration directory instead.
   */
  home: string;
  /** Where global skills live; `<here>/devflow/SKILL.md` is written. */
  skillsDir: string;
};

/** `~/x` expanded against the current home directory. */
const home = (...segments: string[]): string =>
  path.join(os.homedir(), ...segments);

/** `$XDG_CONFIG_HOME`, or `~/.config` where the variable is unset. */
const configHome = (): string =>
  process.env.XDG_CONFIG_HOME?.trim() || home(".config");

/** An agent that lets an env var move its configuration directory. */
const overridable = (variable: string, fallback: string): string =>
  process.env[variable]?.trim() || fallback;

/**
 * The agents DevFlow knows how to teach, and where each one reads global
 * skills from.
 *
 * Every entry has a *documented* location. Agents whose path could only be
 * inferred (Roo Code, Kilo, Crush, `~/.windsurf`) are deliberately absent: a
 * wrong guess litters a home directory with a file nothing ever reads. Most
 * of them read `~/.agents/skills` anyway, which is the first target here.
 */
export const userTargets = (): AgentTarget[] => {
  const claudeHome = overridable("CLAUDE_CONFIG_DIR", home(".claude"));
  const piHome = overridable("PI_CODING_AGENT_DIR", home(".pi", "agent"));

  return [
    // The cross-agent convention: the primary user-scope location for Codex,
    // Cline, Warp and Zed, and a supported alias for most of the others. One
    // write here reaches the largest number of agents.
    {
      id: "agents",
      label: "~/.agents (Codex, Cline, Warp, Zed…)",
      home: home(".agents"),
      skillsDir: home(".agents", "skills"),
    },
    {
      id: "claude",
      label: "Claude Code",
      home: claudeHome,
      skillsDir: path.join(claudeHome, "skills"),
    },
    {
      id: "cursor",
      label: "Cursor",
      home: home(".cursor"),
      skillsDir: home(".cursor", "skills"),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      home: home(".gemini"),
      skillsDir: home(".gemini", "skills"),
    },
    {
      id: "amp",
      label: "Amp",
      home: path.join(configHome(), "amp"),
      skillsDir: path.join(configHome(), "agents", "skills"),
    },
    {
      id: "opencode",
      label: "opencode",
      home: path.join(configHome(), "opencode"),
      skillsDir: path.join(configHome(), "opencode", "skills"),
    },
    {
      id: "goose",
      label: "goose",
      home: path.join(configHome(), "goose"),
      skillsDir: path.join(configHome(), "goose", "skills"),
    },
    {
      id: "factory",
      label: "Factory droid",
      home: home(".factory"),
      skillsDir: home(".factory", "skills"),
    },
    {
      id: "pi",
      label: "pi",
      home: piHome,
      skillsDir: path.join(piHome, "skills"),
    },
    // Deprecated upstream in favour of ~/.agents, but still read, and it is
    // what an existing Codex install already has. Never created from scratch:
    // it is skipped unless it is already there, and `--all` leaves it alone.
    {
      id: "codex-legacy",
      label: "Codex CLI (legacy ~/.codex)",
      home: home(".codex", "skills"),
      skillsDir: home(".codex", "skills"),
    },
  ];
};

/**
 * Project scope: one directory that around nine agents read from a checkout.
 * There is no per-agent variation worth encoding here.
 */
export const projectTargets = (root: string): AgentTarget[] => [
  {
    id: "agents",
    label: ".agents/skills (this checkout)",
    home: root,
    skillsDir: path.join(root, ".agents", "skills"),
  },
];

/** `codex-legacy` exists to be refreshed, never to be created. */
const NEVER_CREATED = new Set(["codex-legacy"]);

export type SkillAction =
  | "installed"
  | "updated"
  | "up-to-date"
  | "removed"
  | "skipped";

export type SkillOutcome = {
  /** Agent ids sharing this directory, e.g. `["agents"]`. */
  agents: string[];
  label: string;
  path: string;
  /** What happened, or would have happened under `--dry-run`. */
  action: SkillAction;
  /** Version stamped in the file that is there now, when there is one. */
  installedVersion?: string | null;
  /** Why it was skipped; absent otherwise. */
  reason?: string;
};

export type SyncOptions = {
  scope?: SkillScope;
  /** Root of the checkout, for `scope: "project"`. */
  projectRoot?: string;
  /** Install into every known agent, creating directories as needed. */
  all?: boolean;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  /** Restrict to these agent ids; empty means all of them. */
  only?: string[];
};

/** Directory holding one target's copy of the skill. */
const skillDir = (target: AgentTarget): string =>
  path.join(target.skillsDir, "devflow");

/** The one file DevFlow owns inside that directory. */
const skillFile = (target: AgentTarget): string =>
  path.join(skillDir(target), "SKILL.md");

/**
 * The version DevFlow stamped into an installed skill, or null when the file
 * predates stamping or was written by something else. `metadata` is a
 * free-form string map in the Agent Skills spec, so this is legal frontmatter
 * that no agent has to understand.
 */
export const stampedVersion = (text: string): string | null =>
  /^\s{2,}devflow-version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() ??
  null;

/**
 * The skill as it should appear on disk: the shipped text with the running
 * DevFlow version recorded in its frontmatter, so `--status` can tell a stale
 * copy from a current one without diffing the whole file.
 */
export const stamp = (text: string, version: string): string => {
  const body = text.replace(
    /^---\n([\s\S]*?)\n---\n/,
    (_match, frontmatter: string) => {
      const cleaned = frontmatter
        .replace(/^metadata:\n(?:\s{2,}\S.*\n)*/m, "")
        .replace(/\s*$/, "");
      return `---\n${cleaned}\nmetadata:\n  devflow-version: "${version}"\n  devflow-source: "@iziatask/devflow"\n---\n`;
    },
  );
  return body;
};

export class AgentSkillsService {
  constructor(private readonly version: string) {}

  /** Targets whose configuration directory exists on this machine. */
  async detect(options: SyncOptions = {}): Promise<AgentTarget[]> {
    const candidates = this.select(options);
    const present = await Promise.all(
      candidates.map(target => fs.pathExists(target.home)),
    );
    return candidates.filter((_, index) => present[index]);
  }

  /**
   * What is on disk right now, per directory: whether the skill is there and
   * whether it matches this DevFlow. Writes nothing.
   */
  async status(options: SyncOptions = {}): Promise<SkillOutcome[]> {
    const wanted = stamp(await fs.readFile(skillPath(), "utf8"), this.version);
    const outcomes: SkillOutcome[] = [];

    for (const group of this.groups(options)) {
      const file = skillFile(group.target);
      const current = await fs.readFile(file, "utf8").catch(() => null);
      if (current === null) {
        outcomes.push({
          ...this.describe(group),
          action: "skipped",
          reason: (await fs.pathExists(group.target.home))
            ? "not installed"
            : "agent not installed",
        });
        continue;
      }
      outcomes.push({
        ...this.describe(group),
        action: current === wanted ? "up-to-date" : "updated",
        installedVersion: stampedVersion(current),
      });
    }

    return outcomes;
  }

  /**
   * Write `devflow/SKILL.md` into each skills directory. Directories whose
   * agent is not installed are skipped unless `all` is set. Rewrites only
   * when the content differs, so running this on every herdr start is free.
   */
  async install(options: SyncOptions = {}): Promise<SkillOutcome[]> {
    const text = stamp(await fs.readFile(skillPath(), "utf8"), this.version);
    const outcomes: SkillOutcome[] = [];

    for (const group of this.groups(options)) {
      const { target } = group;
      const file = skillFile(target);
      const exists = await fs.pathExists(target.home);
      const create = options.all && !NEVER_CREATED.has(target.id);
      if (!exists && !create) {
        outcomes.push({
          ...this.describe(group),
          action: "skipped",
          reason: "agent not installed",
        });
        continue;
      }

      const current = await fs.readFile(file, "utf8").catch(() => null);
      if (current === text) {
        outcomes.push({
          ...this.describe(group),
          action: "up-to-date",
          installedVersion: stampedVersion(current),
        });
        continue;
      }

      if (!options.dryRun) {
        await fs.ensureDir(skillDir(target));
        await fs.writeFile(file, text);
      }
      outcomes.push({
        ...this.describe(group),
        action: current === null ? "installed" : "updated",
        installedVersion: current === null ? null : stampedVersion(current),
      });
    }

    return outcomes;
  }

  /**
   * Remove the skill DevFlow installed. Only `devflow/SKILL.md` and the
   * directory holding it go; the agent's other skills and the skills
   * directory itself are left exactly as they were.
   */
  async uninstall(options: SyncOptions = {}): Promise<SkillOutcome[]> {
    const outcomes: SkillOutcome[] = [];

    for (const group of this.groups(options)) {
      const file = skillFile(group.target);
      if (!(await fs.pathExists(file))) {
        outcomes.push({
          ...this.describe(group),
          action: "skipped",
          reason: "nothing installed",
        });
        continue;
      }
      if (!options.dryRun) {
        await fs.remove(file);
        // Succeeds only while DevFlow left it empty: a user file next to it
        // keeps the directory alive, which is what we want.
        await fs.rmdir(skillDir(group.target)).catch(() => {});
      }
      outcomes.push({ ...this.describe(group), action: "removed" });
    }

    return outcomes;
  }

  /** Every distinct skills directory, with the agents that share it. */
  private groups(
    options: SyncOptions,
  ): Array<{ target: AgentTarget; ids: string[]; label: string }> {
    const byPath = new Map<
      string,
      { target: AgentTarget; ids: string[]; label: string }
    >();
    for (const target of this.select(options)) {
      const key = path.resolve(target.skillsDir);
      const existing = byPath.get(key);
      if (existing) {
        existing.ids.push(target.id);
        existing.label = `${existing.label}, ${target.label}`;
        continue;
      }
      byPath.set(key, { target, ids: [target.id], label: target.label });
    }
    return [...byPath.values()];
  }

  private describe(group: {
    ids: string[];
    label: string;
    target: AgentTarget;
  }): Pick<SkillOutcome, "agents" | "label" | "path"> {
    return {
      agents: group.ids,
      label: group.label,
      path: skillFile(group.target),
    };
  }

  private select(options: SyncOptions): AgentTarget[] {
    const all =
      options.scope === "project"
        ? projectTargets(options.projectRoot ?? process.cwd())
        : userTargets();
    const only = options.only ?? [];
    if (only.length === 0) return all;

    const wanted = new Set(only.map(id => id.toLowerCase()));
    const unknown = [...wanted].filter(id => !all.some(t => t.id === id));
    if (unknown.length > 0) {
      throw new DevflowError(
        "INVALID_ARGUMENT",
        `Unknown agent(s): ${unknown.join(", ")}. Known: ${all.map(t => t.id).join(", ")}`,
      );
    }
    return all.filter(target => wanted.has(target.id));
  }
}
