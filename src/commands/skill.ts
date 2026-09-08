import { Command } from "commander";
import { readFileSync } from "node:fs";
import { skillPath } from "../lib/package-paths.js";
import { printJson } from "../lib/json-output.js";
import { version } from "../lib/version.js";

/**
 * `devflow skill`: print the agent skill on stdout, for an agent that wants
 * the instructions right now without installing anything. The binary is the
 * source of truth; `devflow setup-agents` writes this same text into the
 * skills directory of every agent on the machine.
 */
export const skillCommand = new Command()
  .name("skill")
  .description("Print the DevFlow agent skill (SKILL.md)")
  .option("--json", "Wrap the skill in a JSON object")
  .action(options => {
    const text = readFileSync(skillPath(), "utf8");
    if (options.json) printJson({ version: version(), skill: text });
    else process.stdout.write(text);
  });
