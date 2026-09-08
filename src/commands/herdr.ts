import { Command } from "commander";
import chalk from "chalk";
import { prisma } from "../db/index.js";
import {
  AgentSkillsService,
  HerdrService,
  sortedPorts,
} from "../services/index.js";
import { version } from "../lib/version.js";

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
    // Same installer as `devflow setup-agents`, so linking the plugin is
    // enough for the agents on this machine to know how DevFlow works.
    const skills = (
      await new AgentSkillsService(version()).install()
    ).filter(
      o => o.action === "installed" || o.action === "updated",
    ).length;
    console.log(
      chalk.green(
        `Synced ${projects.length} projects, labelled ${labelled} open environments, ${skills} agent skill(s) refreshed`,
      ),
    );
    await prisma.$disconnect();
  });

export const herdrCommand = new Command()
  .name("herdr")
  .description("herdr integration helpers")
  .addCommand(syncCommand);
