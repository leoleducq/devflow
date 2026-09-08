import { Command } from "commander";
import { readFileSync } from "node:fs";
import { skillPath } from "../lib/package-paths.js";

/**
 * `devflow skill`: print the agent skill, to install where an agent reads
 * skills (`~/.claude/skills/devflow/SKILL.md`, `~/.pi/agent/skills/devflow/`).
 * The installed binary is the source of truth; `devflow herdr sync` writes it
 * into those directories for you.
 */
export const skillCommand = new Command()
  .name("skill")
  .description("Print the DevFlow agent skill (SKILL.md)")
  .action(() => {
    process.stdout.write(readFileSync(skillPath(), "utf8"));
  });
