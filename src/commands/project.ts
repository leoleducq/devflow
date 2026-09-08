import { Command } from "commander";
import { colors } from "../lib/colors.js";
import * as prompts from "../lib/interactive.js";
import {
  GitHubService,
  LinearService,
  TemplateService,
} from "../services/index.js";
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
  registrationAnswers,
  REGISTRATION_FLAGS,
} from "../lib/register-project.js";
import {
  failCommand,
  printJson,
  redact,
  startSpinner,
} from "../lib/json-output.js";
import { printTable, printPairs } from "../lib/table.js";
import { DevflowError } from "../lib/errors.js";

export const projectCommand = new Command()
  .name("project")
  .description("Manage projects");

/** The project a subcommand names, or a coded failure telling the user so. */
const requireProject = async (name: string) => {
  const project = await prisma.project.findUnique({ where: { name } });
  if (!project)
    throw new DevflowError("PROJECT_NOT_FOUND", `Project '${name}' not found`);
  return project;
};

const addCommand = projectCommand
  .command("add")
  .description("Register a project, detecting its apps, ports and dev commands")
  .argument("[path]", "Path to the project directory (default: cwd)")
  .option("-y, --yes", "Accept everything detected without prompting")
  .option("--json", "Machine-readable output");

// Every question the wizard asks also has a flag, so the whole registration
// works with no terminal attached.
for (const [flag, description] of REGISTRATION_FLAGS) {
  addCommand.option(flag, description);
}

addCommand.action(async (pathArg: string | undefined, options) => {
  const spinner = startSpinner("Inspecting project…", options.json);
  try {
    const inspection = await inspectForRegistration(pathArg ?? process.cwd());
    spinner.stop();
    const project = await registerProject(inspection, {
      interactive: !options.yes,
      json: options.json,
      answers: registrationAnswers(options),
    });

    if (options.json) {
      printJson(redact(project));
      return;
    }
    console.log();
    console.log(
      `${colors.green("✔")} Project ${colors.bold(project.name)} registered`,
    );
    console.log(
      colors.dim(`Inspect it with: devflow project get ${project.name}`),
    );
  } catch (error) {
    spinner.stop();
    failCommand(error, options.json);
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
        printJson(redact(projects));
        return;
      }

      if (projects.length === 0) {
        console.log(colors.yellow("No projects registered"));
        console.log(
          colors.dim("Register one with:"),
          colors.white("devflow init"),
        );
        return;
      }

      console.log();
      printTable(
        projects.map(project => {
          const apps = parseJsonArray(project.apps);
          return [
            colors.bold(project.name),
            colors.dim(project.type),
            apps.length > 0 ? apps.join(", ") : colors.dim("-"),
            colors.dim(project.path),
          ];
        }),
        {
          columns: [
            { header: "NAME" },
            { header: "TYPE" },
            { header: "APPS" },
            { header: "PATH" },
          ],
        },
      );
      console.log();
      console.log(colors.dim(`${projects.length} project(s)`));
    } catch (error) {
      failCommand(error, options.json);
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
      if (!project)
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${name}' not found`,
        );

      if (options.json) {
        printJson(redact(project));
        return;
      }

      console.log();
      console.log(colors.bold.underline(project.name));
      console.log();
      printPairs(
        describeProject(project).map(([field, value]) => [
          field,
          value === "-" ? colors.dim("-") : value,
        ]),
      );
      console.log();
      // The flags are kebab-case while the fields above print camelCase, so
      // point at `set --help` rather than inviting `--dbEnvVarName`.
      console.log(
        colors.dim(
          `Change one with: devflow project set ${project.name} --<flag> <value>   (flags: devflow project set --help)`,
        ),
      );
    } catch (error) {
      failCommand(error, options.json);
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
        `${colors.green("✔")} ${colors.bold(field)} updated on ${updated.name}`,
      );
    }
  } catch (error) {
    failCommand(error);
  } finally {
    await prisma.$disconnect();
  }
});

projectCommand
  .command("inspect")
  .description("Re-detect apps, ports and dev commands from a project's files")
  .argument("<name>", "Project name")
  .option("--apply", "Write what was detected back onto the project")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project)
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${name}' not found`,
        );

      const inspection = await new TemplateService().inspectProject(
        project.path,
      );

      if (!options.json) {
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
        console.log();
        printPairs(rows.map(([label, value]) => [label, value || colors.dim("-")]));
        console.log();
      }

      if (!options.apply) {
        if (options.json) printJson({ project: project.name, ...inspection });
        else
          console.log(colors.dim("Pass --apply to save these onto the project"));
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
      if (options.json) printJson({ project: project.name, ...inspection });
      else console.log(colors.green(`${project.name} updated`));
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * Resolve what the user typed for `--team` against the teams the key can see.
 * A team key (`ENG`), a name and a UUID all work, because an agent writing a
 * config file has whichever of the three it happened to be given.
 */
const resolveTeam = (
  teams: Array<{ id: string; name: string; key: string }>,
  wanted: string,
): { id: string; name: string; key: string } => {
  const needle = wanted.trim().toLowerCase();
  const match = teams.find(
    team =>
      team.id.toLowerCase() === needle ||
      team.key.toLowerCase() === needle ||
      team.name.toLowerCase() === needle,
  );
  if (match) return match;
  throw new DevflowError(
    "INVALID_ARGUMENT",
    `No Linear team matches '${wanted}'. This key sees: ${teams
      .map(team => `${team.key} (${team.name})`)
      .join(", ")}`,
  );
};

/**
 * `devflow project linear`: connect a project to Linear.
 *
 * Every question it can ask has a flag behind it, so an agent can configure
 * Linear end to end with no terminal: `--api-key` and `--team` are all it
 * needs, and `--json` reports what was stored. Without them, and only on a
 * real terminal, it falls back to asking.
 */
projectCommand
  .command("linear")
  .description("Connect a project to Linear, picking the team from a list")
  .argument("<name>", "Project name")
  .option("--api-key <key>", "Linear API key (asked for when omitted)")
  .option("--team <id-or-key>", "Linear team by id, key (ENG) or name")
  .option("--project <id-or-name>", "Restrict issues to one Linear project")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow project linear myapp                       ask for key and team
  $ devflow project linear myapp --api-key lin_api_… --team ENG
  $ devflow project linear myapp --team ENG --project "Q3 roadmap" --json`,
  )
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project)
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${name}' not found`,
        );

      // A key already on the project counts as provided: reconnecting to
      // pick a different team should not ask for the key again.
      const apiKey = (
        await prompts.askFor<string>({
          provided: options.apiKey ?? project.linearApiKey ?? undefined,
          what: "A Linear API key",
          flag: "--api-key",
          context: { json: options.json },
          ask: () =>
            prompts.password(
              "Linear API key (Settings → Security & access → Personal API keys)",
            ),
        })
      ).trim();
      if (!apiKey) throw new Error("An API key is required");

      const spinner = startSpinner("Loading Linear teams…", options.json);
      const linear = new LinearService(apiKey);
      const teams = await linear.listTeams();
      spinner.stop();
      if (teams.length === 0) throw new Error("This key sees no Linear team");

      const teamId = options.team
        ? resolveTeam(teams, String(options.team)).id
        : await prompts.askFor<string>({
            provided: undefined,
            what: "A Linear team",
            flag: "--team <id-or-key>",
            context: { json: options.json },
            ask: () =>
              prompts.select({
                message: "Team the issues come from",
                options: teams.map(team => ({
                  value: team.id,
                  label: `${team.key} — ${team.name}`,
                })),
                initialValue: project.linearTeamId ?? teams[0]?.id,
              }),
          });

      // --project is optional everywhere: an unset filter means "every issue
      // of the team", which is the sensible default rather than a question.
      let linearProjectId: string | null = project.linearProjectId;
      if (options.project) {
        const wanted = String(options.project).trim().toLowerCase();
        const projects = await linear.listProjects(teamId);
        const match = projects.find(
          p => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted,
        );
        if (!match) {
          throw new DevflowError(
            "INVALID_ARGUMENT",
            `No Linear project matches '${options.project}' in this team.${
              projects.length > 0
                ? ` Known: ${projects.map(p => p.name).join(", ")}`
                : " This team has no projects."
            }`,
          );
        }
        linearProjectId = match.id;
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { linearApiKey: apiKey, linearTeamId: teamId, linearProjectId },
      });

      const team = teams.find(t => t.id === teamId);
      if (options.json) {
        printJson({
          project: project.name,
          linearTeamId: teamId,
          linearTeamKey: team?.key ?? null,
          linearProjectId,
          connected: true,
        });
        return;
      }
      console.log(
        `${colors.green("✔")} ${project.name} is connected to Linear team ${colors.bold(
          team?.key ?? teamId,
        )}`,
      );
      console.log(
        colors.dim(
          `List its issues with: devflow project issues ${project.name}`,
        ),
      );
    } catch (error) {
      failCommand(error, options.json);
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
      if (!project)
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${name}' not found`,
        );
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
        printJson(issues);
        return;
      }
      for (const issue of issues) {
        console.log(
          `${colors.bold(issue.identifier)}  ${issue.title}  ${colors.dim(issue.branchName)}`,
        );
      }
    } catch (error) {
      failCommand(error, options.json);
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
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await prisma.project.findUnique({ where: { name } });
      if (!project)
        throw new DevflowError(
          "PROJECT_NOT_FOUND",
          `Project '${name}' not found`,
        );

      // Unregistering is cheap to undo but easy to do by accident, so it is
      // confirmed — and a caller that cannot be asked says --yes instead of
      // waiting on a question it will never receive.
      if (!options.yes) {
        if (!prompts.canPrompt({ json: options.json })) {
          throw new DevflowError(
            "CONFIRMATION_REQUIRED",
            `Removing project '${name}' needs confirmation; pass --yes`,
          );
        }
        const confirmed = await prompts.confirm({
          message: `Remove project ${name}?`,
          initialValue: false,
        });
        if (!confirmed) {
          console.log(colors.yellow("Cancelled"));
          return;
        }
      }

      await prisma.project.delete({ where: { name } });
      if (options.json) printJson({ project: name, removed: true });
      else console.log(`${colors.green("✔")} Project '${name}' removed`);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow project prs`: the open pull requests an environment could be
 * created for. The number it prints is what `devflow create <project> --pr`
 * takes, which is the only reason this list exists in a CLI.
 */
projectCommand
  .command("prs")
  .alias("pull-requests")
  .description("List open pull requests of a project (needs gh)")
  .argument("<name>", "Project name")
  .option("--limit <n>", "Maximum pull requests to list", "50")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await requireProject(name);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--limit expects a positive integer, got '${options.limit}'`,
        );
      }

      const prs = await new GitHubService().listPullRequests(
        project.path,
        limit,
      );

      // Which ones already have an environment: the answer to "should I
      // create this or switch to it", and the reason the desktop list was
      // useful at all.
      const existing = new Set(
        (
          await prisma.environment.findMany({
            where: { projectId: project.id, prNumber: { not: null } },
            select: { prNumber: true },
          })
        ).map(env => env.prNumber),
      );

      if (options.json) {
        printJson(
          prs.map(pr => ({ ...pr, hasEnvironment: existing.has(pr.number) })),
        );
        return;
      }

      if (prs.length === 0) {
        console.log(colors.yellow(`No open pull requests in ${project.name}`));
        return;
      }

      console.log();
      printTable(
        prs.map(pr => [
          colors.bold(`#${pr.number}`),
          pr.title,
          colors.dim(pr.branch),
          colors.dim(pr.author),
          existing.has(pr.number)
            ? colors.green("env")
            : pr.isDraft
              ? colors.dim("draft")
              : "",
        ]),
        {
          columns: [
            { header: "PR" },
            { header: "TITLE" },
            { header: "BRANCH" },
            { header: "AUTHOR" },
            { header: "" },
          ],
        },
      );
      console.log();
      console.log(
        colors.dim("Create an environment for one with:"),
        colors.white(`devflow create ${project.name} --pr <number>`),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow project branches`: the local branches of a project's checkout,
 * newest commit first. The other half of "what can I create an environment
 * for" — a branch that already exists is created without cutting a new one.
 */
projectCommand
  .command("branches")
  .description("List local branches of a project's checkout")
  .argument("<name>", "Project name")
  .option("--limit <n>", "Maximum branches to list", "30")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const project = await requireProject(name);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--limit expects a positive integer, got '${options.limit}'`,
        );
      }

      const branches = (
        await new GitHubService().listBranches(project.path)
      ).slice(0, limit);

      const withEnvironments = new Set(
        (
          await prisma.environment.findMany({
            where: { projectId: project.id },
            select: { branch: true },
          })
        ).map(env => env.branch),
      );

      if (options.json) {
        printJson(
          branches.map(branch => ({
            ...branch,
            hasEnvironment: withEnvironments.has(branch.name),
          })),
        );
        return;
      }

      if (branches.length === 0) {
        console.log(colors.yellow(`No branches in ${project.path}`));
        return;
      }

      console.log();
      printTable(
        branches.map(branch => [
          branch.isCurrent ? colors.green("*") : " ",
          colors.bold(branch.name),
          colors.dim(branch.lastCommitDate.slice(0, 10)),
          withEnvironments.has(branch.name) ? colors.green("env") : "",
        ]),
        {
          columns: [
            { header: "" },
            { header: "BRANCH" },
            { header: "LAST COMMIT" },
            { header: "" },
          ],
        },
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
