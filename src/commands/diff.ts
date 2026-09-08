import { Command } from "commander";
import { colors } from "../lib/colors.js";
import { prisma } from "../db/index.js";
import { EnvironmentService } from "../services/index.js";
import { resolveEnvironment } from "../lib/resolve-environment.js";
import { failCommand, printJson } from "../lib/json-output.js";
import { DevflowError } from "../lib/errors.js";

/**
 * What this environment changed.
 *
 * `git diff` in the worktree answers a narrower question: it does not know
 * the base branch the environment was cut from, so it cannot tell "the work
 * on this branch" from "everything since the last commit". DevFlow stores
 * that base, fetches it, and diffs against the merge base — which is what
 * the desktop Diff tab showed and what an agent asking "what did I change"
 * actually wants.
 *
 * Lockfiles are excluded: they are noise in every review and enormous in a
 * JSON payload.
 */

/** A commit's headline fields; the diff itself is only printed on request. */
type Commit = {
  hash: string;
  message: string;
  author: string;
  date: string;
  diff: string;
};

export const diffCommand = new Command()
  .name("diff")
  .description(
    "Show what an environment changed against its base branch (this checkout by default)",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option(
    "-u, --uncommitted",
    "Only the uncommitted changes, instead of the whole branch",
  )
  .option("--stat", "Print a summary of the changed files instead of the patch")
  .option("--json", "Machine-readable output")
  .addHelpText(
    "after",
    `
Examples:
  $ devflow diff                  the branch's changes vs its base
  $ devflow diff --uncommitted    only what is not committed yet
  $ devflow diff --stat           which files changed, and by how much
  $ devflow diff --json           the patch as a JSON string`,
  )
  .action(async (envName: string | undefined, options) => {
    try {
      const env = await resolveEnvironment({ name: envName });
      const service = new EnvironmentService(prisma);
      const patch = options.uncommitted
        ? await service.getChanges(env.id)
        : await service.getDiff(env.id);

      const files = summarise(patch);

      if (options.json) {
        printJson({
          environment: env.name,
          branch: env.branch,
          baseBranch: env.baseBranch,
          scope: options.uncommitted ? "uncommitted" : "branch",
          files,
          diff: options.stat ? undefined : patch,
        });
        return;
      }

      if (!patch.trim()) {
        console.log(
          colors.yellow(
            options.uncommitted
              ? `${env.name} has no uncommitted changes`
              : `${env.name} has no changes against ${env.baseBranch}`,
          ),
        );
        return;
      }

      if (options.stat) {
        for (const file of files) {
          console.log(
            `${colors.green(`+${file.added}`)} ${colors.red(`-${file.removed}`)}  ${file.path}`,
          );
        }
        console.log();
        console.log(colors.dim(`${files.length} file(s) changed`));
        return;
      }

      console.log(paint(patch));
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

export const historyCommand = new Command()
  .name("history")
  .description(
    "List the commits an environment added on top of its base branch",
  )
  .argument("[env-name]", "Environment name (default: the environment of cwd)")
  .option("-n, --lines <n>", "How many commits to show", "20")
  .option("-p, --patch", "Include each commit's diff")
  .option("--json", "Machine-readable output")
  .action(async (envName: string | undefined, options) => {
    try {
      const limit = Number(options.lines);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DevflowError(
          "INVALID_ARGUMENT",
          `--lines expects a positive integer, got '${options.lines}'`,
        );
      }

      const env = await resolveEnvironment({ name: envName });
      const commits = (
        (await new EnvironmentService(prisma).getHistory(env.id)) as Commit[]
      ).slice(0, limit);

      if (options.json) {
        printJson({
          environment: env.name,
          branch: env.branch,
          baseBranch: env.baseBranch,
          commits: commits.map(commit =>
            options.patch ? commit : { ...commit, diff: undefined },
          ),
        });
        return;
      }

      if (commits.length === 0) {
        console.log(
          colors.yellow(`${env.name} has no commit on top of ${env.baseBranch}`),
        );
        return;
      }

      for (const commit of commits) {
        console.log(
          `${colors.yellow(commit.hash.slice(0, 8))} ${commit.message} ${colors.dim(
            `— ${commit.author}, ${commit.date.slice(0, 10)}`,
          )}`,
        );
        if (options.patch && commit.diff) console.log(paint(commit.diff));
      }
    } catch (error) {
      failCommand(error, options.json);
    } finally {
      await prisma.$disconnect();
    }
  });

/** Per-file added/removed counts, read off the patch itself. */
function summarise(
  patch: string,
): Array<{ path: string; added: number; removed: number }> {
  const files: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | null = null;

  for (const line of patch.split("\n")) {
    const header = line.match(/^diff --git a\/\S+ b\/(\S+)/);
    if (header) {
      current = { path: header[1]!, added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // `+++`/`---` are the file headers, not content lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return files;
}

/** Colour a unified diff the way `git diff` would, without a pager. */
function paint(patch: string): string {
  return patch
    .split("\n")
    .map(line => {
      if (line.startsWith("+++") || line.startsWith("---"))
        return colors.bold(line);
      if (line.startsWith("diff --git")) return colors.bold(line);
      if (line.startsWith("@@")) return colors.cyan(line);
      if (line.startsWith("+")) return colors.green(line);
      if (line.startsWith("-")) return colors.red(line);
      return line;
    })
    .join("\n");
}
