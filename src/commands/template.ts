import { Command } from "commander";
import { resolve } from "node:path";
import { colors } from "../lib/colors.js";
import * as prompts from "../lib/interactive.js";
import { prisma } from "../db/index.js";
import { TemplateService } from "../services/index.js";
import {
  registerProject,
  inspectForRegistration,
} from "../lib/register-project.js";
import { failCommand, printJson, startSpinner } from "../lib/json-output.js";
import { printTable } from "../lib/table.js";
import { DevflowError } from "../lib/errors.js";

/**
 * Templates: repositories a new project is scaffolded from.
 *
 * The desktop app kept a saved list of them and a "new project from
 * template" dialog. The list is worth keeping — it is the difference between
 * remembering a repo slug and typing it — but the dialog's job here is one
 * command: clone, detect the apps, optionally create the GitHub repo, and
 * register the result as a DevFlow project so `devflow create` works on it
 * immediately.
 */
export const templateCommand = new Command()
  .name("template")
  .description("Repositories new projects are scaffolded from");

templateCommand
  .command("list")
  .alias("ls")
  .description("List saved templates")
  .option("--json", "Machine-readable output")
  .action(async options => {
    try {
      const templates = await prisma.template.findMany({
        orderBy: { createdAt: "desc" },
      });

      if (options.json) {
        printJson(templates);
        return;
      }
      if (templates.length === 0) {
        console.log(colors.yellow("No template saved"));
        console.log(
          colors.dim("Save one with:"),
          colors.white("devflow template add <name> <repo>"),
        );
        return;
      }
      printTable(
        templates.map(template => [
          colors.bold(template.name),
          colors.dim(template.repo),
          template.description || colors.dim("-"),
        ]),
        {
          columns: [
            { header: "NAME" },
            { header: "REPO" },
            { header: "DESCRIPTION" },
          ],
        },
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

templateCommand
  .command("add")
  .description("Save a template repository under a name")
  .argument("<name>", "Name to refer to it by")
  .argument("<repo>", "owner/repo, or a full git URL")
  .option("-d, --description <text>", "What it is for")
  .option("--json", "Machine-readable output")
  .action(async (name: string, repo: string, options) => {
    try {
      const template = await prisma.template.create({
        data: { name, repo, description: options.description ?? "" },
      });
      if (options.json) printJson(template);
      else
        console.log(
          `${colors.green("✔")} Template ${colors.bold(name)} saved (${repo})`,
        );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

templateCommand
  .command("remove")
  .alias("rm")
  .description("Forget a saved template")
  .argument("<name>", "Template name")
  .option("--json", "Machine-readable output")
  .action(async (name: string, options) => {
    try {
      const template = await prisma.template.findUnique({ where: { name } });
      if (!template)
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `No template named '${name}'`,
        );
      await prisma.template.delete({ where: { name } });
      if (options.json) printJson({ template: name, removed: true });
      else console.log(`${colors.green("✔")} Template '${name}' removed`);
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/**
 * `devflow template new`: scaffold a project and register it in one go.
 *
 * Cloning a template and then registering it by hand is two commands with a
 * gap in the middle where the project exists but DevFlow does not know about
 * it. Doing both here means the next command can be `devflow create`.
 */
templateCommand
  .command("new")
  .description("Create a project from a template and register it")
  .argument("<name>", "Project name")
  .argument("[template]", "Saved template name, or owner/repo (asked when omitted)")
  .option("--path <path>", "Where to create it (default: ./<name>)")
  .option("--github <repo>", "Also create a GitHub repository, as owner/repo or repo")
  .option("--public", "Make the created GitHub repository public")
  .option("-y, --yes", "Accept everything detected without prompting")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow template new myapp turborepo-starter
  $ devflow template new myapp acme/starter --path ~/code/myapp
  $ devflow template new myapp acme/starter --github acme/myapp --yes`,
  )
  .action(async (name: string, templateArg: string | undefined, options) => {
    const context = { json: options.json, yes: options.yes };
    try {
      const saved = await prisma.template.findMany({
        orderBy: { createdAt: "desc" },
      });

      // A saved name resolves to its repo; anything else is taken as a repo
      // reference, so a template does not have to be saved to be used.
      const chosen = await prompts.askFor<string>({
        provided: templateArg,
        what: "A template",
        flag: "<template> (a saved name, or owner/repo)",
        context,
        ask: () =>
          prompts.select({
            message: "Template to clone",
            options: saved.map(template => ({
              value: template.repo,
              label: template.name,
              hint: template.repo,
            })),
          }),
      });
      const repo =
        saved.find(template => template.name === chosen)?.repo ?? chosen;

      const targetPath = resolve(options.path ?? name);
      const service = new TemplateService();

      const spinner = startSpinner(`Cloning ${repo}…`, options.json);
      await service.cloneTemplate({
        templateRepo: repo,
        targetPath,
        projectName: name,
      });
      spinner.succeed(colors.green(`Cloned into ${targetPath}`));

      let repoUrl: string | undefined;
      if (options.github) {
        const [org, repoName] = options.github.includes("/")
          ? options.github.split("/")
          : [undefined, options.github];
        const push = startSpinner("Creating the GitHub repository…", options.json);
        repoUrl = await service.setupGitHubRepo({
          targetPath,
          repoName: repoName!,
          org,
          isPrivate: !options.public,
        });
        push.succeed(colors.green(`Pushed to ${repoUrl}`));
      }

      // Register it the same way `devflow init` would, so the detected apps,
      // ports and dev commands are identical whichever door you came through.
      const inspection = await inspectForRegistration(targetPath);
      const project = await registerProject(inspection, {
        interactive: !options.yes,
        json: options.json,
        // The name the user gave this command is the project's name; the
        // template's own package.json name is not.
        answers: { name },
      });

      if (options.json) {
        printJson({
          project: project.name,
          path: targetPath,
          template: repo,
          repoUrl: repoUrl ?? null,
        });
        return;
      }
      console.log();
      console.log(
        `${colors.green("✔")} Project ${colors.bold(project.name)} created from ${repo}`,
      );
      console.log(
        colors.dim("Create your first environment with:"),
        colors.white(`devflow create ${project.name} <branch>`),
      );
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });
