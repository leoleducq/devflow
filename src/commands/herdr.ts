import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import { HerdrService, sortedPorts } from "../services/index.js";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { skillPath } from "../lib/package-paths.js";

/**
 * `devflow herdr sync`: make herdr's sidebar agree with DevFlow. Every project
 * gets a workspace on its main checkout; environments whose worktree is
 * already open get their status and ports as sidebar tokens. Environments
 * are not opened here: `prefix+u` in herdr opens a worktree on demand, and a
 * sidebar with every env ever created is noise.
 */
const syncCommand = new Command()
  .name("sync")
  .description("Open a herdr workspace for every project and environment")
  .action(async () => {
    const herdr = new HerdrService();
    const status = await herdr.status();
    if (!status.running) {
      console.error(chalk.yellow("herdr server is not running"));
      process.exit(1);
    }

    const [projects, environments] = await Promise.all([
      prisma.project.findMany(),
      prisma.environment.findMany({
        where: { worktreePath: { not: "" } },
        include: { ports: true },
      }),
    ]);

    for (const project of projects) {
      try {
        await herdr.ensureWorkspace(project.path, project.name);
      } catch (error) {
        console.error(chalk.yellow(`${project.name}: ${String(error)}`));
      }
    }
    let labelled = 0;
    for (const env of environments) {
      try {
        const workspace = await herdr.findWorkspaceAt(env.worktreePath);
        if (!workspace) continue;
        labelled += 1;
        await herdr.reportWorkspaceMetadata(workspace.id, {
          devflow_status: env.status.toLowerCase(),
          devflow_ports: sortedPorts(env.ports)
            .map(p => `${p.appName}:${p.port}`)
            .join(" "),
        });
      } catch (error) {
        console.error(chalk.yellow(`${env.name}: ${String(error)}`));
      }
    }
    const skills = await installSkills();
    console.log(
      chalk.green(
        `Synced ${projects.length} projects, labelled ${labelled} open environments, ${skills} agent skill(s) refreshed`,
      ),
    );
    await prisma.$disconnect();
  });

/**
 * Where each agent reads global skills. Refreshed on every sync so linking
 * the plugin is enough for agents to know how DevFlow works; there is no way
 * to extend herdr's own skill text from a plugin.
 */
const SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills", "devflow"),
  path.join(os.homedir(), ".pi", "agent", "skills", "devflow"),
  path.join(os.homedir(), ".codex", "skills", "devflow"),
];

const installSkills = async (): Promise<number> => {
  const text = await fs.readFile(skillPath(), "utf8");
  let written = 0;
  for (const dir of SKILL_DIRS) {
    // Only agents that are set up: a missing parent means the agent is absent.
    if (!(await fs.pathExists(path.dirname(dir)))) continue;
    await fs.ensureDir(dir);
    const target = path.join(dir, "SKILL.md");
    const current = await fs.readFile(target, "utf8").catch(() => "");
    if (current !== text) {
      await fs.writeFile(target, text);
      written += 1;
    }
  }
  return written;
};

export const herdrCommand = new Command()
  .name("herdr")
  .description("herdr integration helpers")
  .addCommand(syncCommand);
