import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { LinearService, TemplateService } from "../services/index.js";
import { prisma, parseJsonArray } from "../db/index.js";
import {
  PROJECT_FIELDS,
  buildProjectUpdate,
  describeProject,
} from "../lib/project-fields.js";
import type { ProjectField } from "../lib/project-fields.js";
import {
  registerProject,
  inspectForRegistration,
} from "../lib/register-project.js";

export const projectCommand = new Command()
  .name("project")
  .description("Manage projects");

projectCommand
  .command("add")
  .description("Register a project, detecting its apps, ports and dev commands")
  .argument("[path]", "Path to the project directory (default: cwd)")
  .option("-y, --yes", "Accept everything detected without prompting")
  .action(async (pathArg: string | undefined, options) => {
    const spinner = ora("Inspecting project…").start();
    try {
      const inspection = await inspectForRegistration(pathArg ?? process.cwd());
      spinner.stop();
      const project = await registerProject(inspection, {
        interactive: !options.yes,
      });

      console.log();
      console.log(
        chalk.green(`Project ${chalk.bold(project.name)} registered`),
      );
      console.log(
        chalk.dim(`Inspect it with: devflow project get ${project.name}`),
      );
    } catch (error) {
      spinner.stop();
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

projectCommand
  .command("list")
  .alias("ls")
  .description("List registered projects")
  .option("--json", "Machine-readable output")
  .action(async options => {
    try {
      const projects = await prisma.project.findMany({
        orderBy: { createdAt: "desc" },
      });

      if (options.json) {
        console.log(JSON.stringify(projects));
        return;
      }

      if (projects.length === 0) {
        console.log(chalk.yellow("No projects registered"));
        console.log(
          chalk.dim("Register one with:"),
          chalk.white("devflow init"),
        );
        return;
      }

      console.log();
      console.log(chalk.bold.underline("Registered Projects"));
      console.log();

      for (const project of projects) {
        console.log(chalk.bold(project.name), chalk.dim(`(${project.type})`));
        console.log(chalk.dim("  Path:"), project.path);
        const projectApps = parseJsonArray(project.apps);
        if (projectApps.length > 0) {
          console.log(chalk.dim("  Apps:"), projectApps.join(", "));
        }
        console.log();
      }

      console.log(chalk.dim(`Total: ${projects.length} project(s)`));
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

projectCommand
  .command("get")
  .description("Show every setting of one project")
  .argument("<name>", "Project name")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project) throw new Error(`Project '${name}' not found`);

      if (options.json) {
        console.log(JSON.stringify(project, null, 2));
        return;
      }

      const rows = describeProject(project);
      const width = Math.max(...rows.map(([field]) => field.length));
      console.log();
      console.log(chalk.bold.underline(project.name));
      console.log();
      for (const [field, value] of rows) {
        console.log(
          `${chalk.bold(field.padEnd(width))}  ${value === "-" ? chalk.dim("-") : value}`,
        );
      }
      console.log();
      // The flags are kebab-case while the fields above print camelCase, so
      // point at `set --help` rather than inviting `--dbEnvVarName`.
      console.log(
        chalk.dim(
          `Change one with: devflow project set ${project.name} --<flag> <value>   (flags: devflow project set --help)`,
        ),
      );
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

const setCommand = projectCommand
  .command("set")
  .description("Change one or more settings of a project")
  .argument("<name>", "Project name");

// One --flag per editable column, described from a single source of truth.
for (const field of Object.keys(PROJECT_FIELDS) as ProjectField[]) {
  const spec = PROJECT_FIELDS[field];
  setCommand.option(`--${spec.flag} ${spec.placeholder}`, spec.description);
}

setCommand.action(async (name: string, options: Record<string, unknown>) => {
  try {
    const project = await prisma.project.findUnique({ where: { name } });
    if (!project) throw new Error(`Project '${name}' not found`);

    const data = await buildProjectUpdate(options);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data,
    });

    for (const field of Object.keys(data)) {
      console.log(
        `${chalk.green("✔")} ${chalk.bold(field)} updated on ${updated.name}`,
      );
    }
  } catch (error) {
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
});

projectCommand
  .command("inspect")
  .description("Re-detect apps, ports and dev commands from a project's files")
  .argument("<name>", "Project name")
  .option("--apply", "Write what was detected back onto the project")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project) throw new Error(`Project '${name}' not found`);

      const inspection = await new TemplateService().inspectProject(
        project.path,
      );

      const rows: Array<[string, string]> = [
        ["apps", inspection.apps.join(", ")],
        [
          "appPorts",
          Object.entries(inspection.appPorts)
            .map(([app, port]) => `${app}:${port}`)
            .join(", "),
        ],
        [
          "devCommands",
          Object.entries(inspection.devCommands)
            .map(([app, cmd]) => `${app}=${cmd}`)
            .join(", "),
        ],
        ["dbEnvVarName", inspection.dbEnvVarName ?? ""],
        ["dbDockerImage", inspection.dbDockerImage ?? ""],
      ];
      const width = Math.max(...rows.map(([label]) => label.length));
      console.log();
      for (const [label, value] of rows) {
        console.log(
          `${chalk.bold(label.padEnd(width))}  ${value || chalk.dim("-")}`,
        );
      }
      console.log();

      if (!options.apply) {
        console.log(chalk.dim("Pass --apply to save these onto the project"));
        return;
      }

      await prisma.project.update({
        where: { id: project.id },
        data: {
          apps: JSON.stringify(inspection.apps),
          appPorts: JSON.stringify(inspection.appPorts),
          devCommands: JSON.stringify(inspection.devCommands),
          ...(inspection.dbEnvVarName
            ? { dbEnvVarName: inspection.dbEnvVarName }
            : {}),
          ...(inspection.dbDockerImage
            ? { dbDockerImage: inspection.dbDockerImage }
            : {}),
        },
      });
      console.log(chalk.green(`${project.name} updated`));
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

projectCommand
  .command("linear")
  .description("Connect a project to Linear, picking the team from a list")
  .argument("<name>", "Project name")
  .option("--api-key <key>", "Linear API key (asked for when omitted)")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project) throw new Error(`Project '${name}' not found`);

      const apiKey: string =
        options.apiKey ??
        project.linearApiKey ??
        (
          await inquirer.prompt<{ apiKey: string }>([
            {
              type: "password",
              name: "apiKey",
              mask: "*",
              message:
                "Linear API key (Settings → Security & access → Personal API keys):",
            },
          ])
        ).apiKey;

      if (!apiKey.trim()) throw new Error("An API key is required");

      const spinner = ora("Loading Linear teams…").start();
      const linear = new LinearService(apiKey.trim());
      const teams = await linear.listTeams();
      spinner.stop();

      if (teams.length === 0) throw new Error("This key sees no Linear team");

      const { teamId } = await inquirer.prompt<{ teamId: string }>([
        {
          type: "list",
          name: "teamId",
          message: "Team the issues come from:",
          choices: teams.map(team => ({
            name: `${team.key} — ${team.name}`,
            value: team.id,
          })),
          default: project.linearTeamId ?? undefined,
        },
      ]);

      await prisma.project.update({
        where: { id: project.id },
        data: { linearApiKey: apiKey.trim(), linearTeamId: teamId },
      });

      const team = teams.find(t => t.id === teamId);
      console.log(
        chalk.green(
          `${project.name} is connected to Linear team ${chalk.bold(team?.key ?? teamId)}`,
        ),
      );
      console.log(
        chalk.dim(
          `List its issues with: devflow project issues ${project.name}`,
        ),
      );
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

projectCommand
  .command("issues")
  .description(
    "Open Linear issues of a project (the ones an env can be created for)",
  )
  .argument("<name>", "Project name")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project) throw new Error(`Project '${name}' not found`);
      if (!project.linearApiKey || !project.linearTeamId) {
        throw new Error(
          `Linear is not configured for ${name}. Connect it with: devflow project linear ${name}`,
        );
      }

      const linear = new LinearService(project.linearApiKey);
      const filterLabels = parseJsonArray(project.linearFilterLabels);
      const issues = await linear.listIssues({
        teamId: project.linearTeamId,
        projectId: project.linearProjectId ?? undefined,
        excludeStates: parseJsonArray(project.linearExcludeStates),
        filterLabels: filterLabels.length > 0 ? filterLabels : undefined,
      });

      if (options.json) {
        console.log(JSON.stringify(issues));
        return;
      }
      for (const issue of issues) {
        console.log(
          `${chalk.bold(issue.identifier)}  ${issue.title}  ${chalk.dim(issue.branchName)}`,
        );
      }
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });

projectCommand
  .command("remove")
  .alias("rm")
  .description("Unregister a project")
  .argument("<name>", "Project name")
  .option("-y, --yes", "Skip confirmation")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project) throw new Error(`Project '${name}' not found`);

      if (!options.yes) {
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
          {
            type: "confirm",
            name: "confirm",
            message: `Remove project ${chalk.cyan(name)}?`,
            default: false,
          },
        ]);
        if (!confirm) {
          console.log(chalk.yellow("Cancelled"));
          return;
        }
      }

      await prisma.project.delete({ where: { name } });
      console.log(chalk.green(`Project '${name}' removed`));
    } catch (error) {
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error)),
      );
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  });
