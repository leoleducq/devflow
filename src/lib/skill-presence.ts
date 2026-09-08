import { existsSync } from "node:fs";
import { join } from "node:path";
import { userTargets } from "../services/agent-skills-service.js";

/**
 * Whether `devflow setup-agents` has already put the skill somewhere an agent
 * reads. Used only to drop the "are you an AI agent?" footer from `--help`
 * once it has served its purpose, so it is deliberately synchronous and
 * failure-tolerant: help output must never wait on the filesystem or throw.
 */
export const skillIsInstalled = (): boolean => {
  try {
    return userTargets().some(target =>
      existsSync(join(target.skillsDir, "devflow", "SKILL.md")),
    );
  } catch {
    return false;
  }
};
