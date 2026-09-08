import { execa } from "execa";
import { join } from "node:path";
import fs from "fs-extra";

/**
 * Fallback when no base branch is known. Callers pass the project's
 * `defaultBaseBranch`; this only covers direct use of the service.
 */
const DEFAULT_BASE_BRANCH = "main";

export class WorktreeService {
  async createWorktree(
    projectPath: string,
    branch: string,
    worktreeLocation: string,
    baseBranch = DEFAULT_BASE_BRANCH,
  ): Promise<string> {
    const worktreeName = branch.replace(/\//g, "-");
    const worktreePath = join(projectPath, worktreeLocation, worktreeName);

    await fs.ensureDir(join(projectPath, worktreeLocation));

    // Fetch latest state from remote
    try {
      await execa("git", ["fetch", "origin"], { cwd: projectPath });
    } catch {
      // Remote might not be available
    }

    // Resolve branch ref: prefer remote branch, then local, then create from baseBranch
    const remoteRef = `origin/${branch}`;
    let hasRemoteBranch = false;
    let hasLocalBranch = false;

    try {
      await execa("git", ["rev-parse", "--verify", remoteRef], {
        cwd: projectPath,
      });
      hasRemoteBranch = true;
    } catch {
      // No remote branch
    }

    if (!hasRemoteBranch) {
      try {
        await execa("git", ["rev-parse", "--verify", branch], {
          cwd: projectPath,
        });
        hasLocalBranch = true;
      } catch {
        // No local branch either
      }
    }

    if (hasRemoteBranch) {
      // Remote branch exists — create or reset local branch to match it
      try {
        await execa("git", ["branch", "-f", branch, remoteRef], {
          cwd: projectPath,
        });
      } catch {
        await execa("git", ["branch", branch, remoteRef], {
          cwd: projectPath,
        });
      }
    } else if (hasLocalBranch) {
      // Local branch exists — use it as-is (e.g. PR branch already checked out)
    } else {
      // Branch doesn't exist anywhere — create from baseBranch
      await execa("git", ["branch", branch, `origin/${baseBranch}`], {
        cwd: projectPath,
      });
    }

    await execa("git", ["worktree", "add", worktreePath, branch], {
      cwd: projectPath,
    });

    return worktreePath;
  }

  async removeWorktree(
    worktreePath: string,
    projectPath: string,
  ): Promise<void> {
    try {
      await execa("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: projectPath,
      });
    } catch {
      // If git worktree remove fails, try manual removal
      await fs.remove(worktreePath);
    }
  }

  async listWorktrees(projectPath: string): Promise<string[]> {
    try {
      const { stdout } = await execa(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: projectPath },
      );

      return stdout
        .split("\n")
        .filter(line => line.startsWith("worktree "))
        .map(line => line.replace("worktree ", ""));
    } catch {
      return [];
    }
  }

  async getCurrentBranch(worktreePath: string): Promise<string> {
    const { stdout } = await execa("git", ["branch", "--show-current"], {
      cwd: worktreePath,
    });
    return stdout.trim();
  }

  async getDiff(worktreePath: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<string> {
    await this.fetchBaseBranch(worktreePath, baseBranch);
    const diffRef = await this.resolveDiffRef(worktreePath, baseBranch);
    const mergeBase = await this.getMergeBase(worktreePath, diffRef);

    const { stdout } = await execa(
      "git",
      ["diff", mergeBase, "HEAD", "--", ".", ":!pnpm-lock.yaml", ":!*.lock"],
      { cwd: worktreePath },
    );

    return stdout;
  }

  async getChanges(worktreePath: string): Promise<string> {
    // Uncommitted changes only (staged + unstaged vs HEAD)
    const { stdout } = await execa(
      "git",
      ["diff", "HEAD", "--", ".", ":!pnpm-lock.yaml", ":!*.lock"],
      { cwd: worktreePath },
    );

    const untrackedDiff = await this.getUntrackedDiff(worktreePath);
    return [stdout, untrackedDiff].filter(Boolean).join("\n");
  }

  async getHistory(
    worktreePath: string,
    baseBranch = DEFAULT_BASE_BRANCH,
  ): Promise<
    {
      hash: string;
      message: string;
      author: string;
      date: string;
      diff: string;
    }[]
  > {
    await this.fetchBaseBranch(worktreePath, baseBranch);
    const diffRef = await this.resolveDiffRef(worktreePath, baseBranch);
    const mergeBase = await this.getMergeBase(worktreePath, diffRef);

    const { stdout: logOutput } = await execa(
      "git",
      ["log", `${mergeBase}..HEAD`, "--format=%H%n%s%n%an%n%aI%n---END---"],
      { cwd: worktreePath },
    );

    if (!logOutput.trim()) return [];

    const commits = logOutput.trim().split("---END---\n").filter(Boolean);
    const results: {
      hash: string;
      message: string;
      author: string;
      date: string;
      diff: string;
    }[] = [];

    for (const block of commits) {
      const lines = block.trim().split("\n");
      if (lines.length < 4) continue;
      const hash = lines[0]!;
      const message = lines[1]!;
      const author = lines[2]!;
      const date = lines[3]!;

      const { stdout: diff } = await execa(
        "git",
        [
          "diff",
          `${hash}~1..${hash}`,
          "--",
          ".",
          ":!pnpm-lock.yaml",
          ":!*.lock",
        ],
        { cwd: worktreePath, reject: false },
      );

      results.push({ hash, message, author, date, diff: diff || "" });
    }

    return results;
  }

  private async fetchBaseBranch(
    worktreePath: string,
    baseBranch: string,
  ): Promise<void> {
    try {
      await execa("git", ["fetch", "origin", baseBranch], {
        cwd: worktreePath,
      });
    } catch {
      // Remote might not be available
    }
  }

  private async resolveDiffRef(
    worktreePath: string,
    baseBranch: string,
  ): Promise<string> {
    const remoteRef = `origin/${baseBranch}`;
    try {
      await execa("git", ["rev-parse", remoteRef], { cwd: worktreePath });
      return remoteRef;
    } catch {
      return baseBranch;
    }
  }

  private async getMergeBase(
    worktreePath: string,
    diffRef: string,
  ): Promise<string> {
    const { stdout } = await execa("git", ["merge-base", diffRef, "HEAD"], {
      cwd: worktreePath,
    });
    return stdout.trim();
  }

  private async getUntrackedDiff(worktreePath: string): Promise<string> {
    const { stdout: untrackedFiles } = await execa(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: worktreePath },
    );

    if (!untrackedFiles.trim()) return "";

    const diffs: string[] = [];
    for (const file of untrackedFiles.trim().split("\n")) {
      if (file.endsWith(".lock") || file === "pnpm-lock.yaml") continue;
      try {
        const { stdout: fileDiff } = await execa(
          "git",
          ["diff", "--no-index", "/dev/null", file],
          { cwd: worktreePath, reject: false },
        );
        if (fileDiff) diffs.push(fileDiff);
      } catch {
        // skip files that can't be diffed
      }
    }

    return diffs.join("\n");
  }
}
