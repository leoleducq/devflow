import { execa } from "execa";
import { DevflowError } from "../lib/errors.js";

export type PullRequestInfo = {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  url: string;
  state: "open" | "closed";
};

/** One open pull request, as `devflow project prs` lists them. */
export type PullRequestSummary = {
  number: number;
  title: string;
  branch: string;
  author: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  labels: string[];
};

/** A local git branch, most-recently-committed first. */
export type BranchSummary = {
  name: string;
  lastCommitDate: string;
  isCurrent: boolean;
};

type GhPrJson = {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
};

type GhPrListJson = {
  number: number;
  title: string;
  headRefName: string;
  author: { login: string } | null;
  url: string;
  createdAt: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  labels: { name: string }[] | null;
};

/**
 * `gh` is the only way DevFlow talks to GitHub: it already holds the user's
 * auth, and shelling out to it beats carrying an API client and a token store
 * for two read-only calls.
 *
 * Its two failure modes — not installed, not logged in — are indistinguishable
 * from a generic execa error to a caller, so they are turned into coded
 * DevFlow errors here rather than surfacing as a raw ENOENT.
 */
export class GitHubService {
  async getPullRequest(
    projectPath: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    const stdout = await this.gh(
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,title,url,state,headRefName,baseRefName",
      ],
      projectPath,
      `Pull request #${prNumber}`,
    );

    const data = JSON.parse(stdout) as GhPrJson;

    return {
      number: data.number,
      title: data.title,
      headBranch: data.headRefName,
      baseBranch: data.baseRefName,
      url: data.url,
      state: data.state === "OPEN" ? "open" : "closed",
    };
  }

  /** Open pull requests of the repository the project's checkout points at. */
  async listPullRequests(
    projectPath: string,
    limit = 50,
  ): Promise<PullRequestSummary[]> {
    const stdout = await this.gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,headRefName,author,url,createdAt,isDraft,reviewDecision,mergeable,labels",
        "--limit",
        String(limit),
      ],
      projectPath,
      "Pull requests",
    );

    return (JSON.parse(stdout) as GhPrListJson[]).map(pr => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      author: pr.author?.login ?? "unknown",
      url: pr.url,
      createdAt: pr.createdAt,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision || null,
      mergeable: pr.mergeable || null,
      labels: (pr.labels ?? []).map(l => l.name),
    }));
  }

  /**
   * Local branches of a checkout. Not GitHub at all, but it is the other half
   * of "what could I create an environment for", which is what the old
   * branches route existed to answer.
   */
  async listBranches(projectPath: string): Promise<BranchSummary[]> {
    const { stdout } = await execa(
      "git",
      [
        "for-each-ref",
        "--sort=-committerdate",
        "refs/heads/",
        "--format=%(refname:short)\t%(committerdate:iso8601)\t%(HEAD)",
      ],
      { cwd: projectPath },
    );

    return stdout
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [name, lastCommitDate, head] = line.split("\t");
        return {
          name: name ?? "",
          lastCommitDate: lastCommitDate ?? "",
          isCurrent: head === "*",
        };
      });
  }

  /**
   * Run `gh`, translating its two structural failures into codes a caller can
   * act on: install the tool, or log in. Everything else is the command's own
   * error and passes through with gh's stderr, which is usually the useful
   * part ("no pull requests found", "not a repository").
   */
  private async gh(
    args: string[],
    cwd: string,
    subject: string,
  ): Promise<string> {
    try {
      const { stdout } = await execa("gh", args, { cwd });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (/ENOENT|command not found/i.test(message)) {
        throw new DevflowError(
          "TOOL_MISSING",
          "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.",
        );
      }
      if (/auth login|not logged into|authentication/i.test(stderr)) {
        throw new DevflowError(
          "TOOL_MISSING",
          "The GitHub CLI is not authenticated. Run `gh auth login`.",
        );
      }
      throw new Error(
        `${subject} could not be read from GitHub: ${stderr.trim() || message}`,
      );
    }
  }
}
