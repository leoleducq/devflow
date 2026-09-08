import { execa } from "execa";

export type PullRequestInfo = {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  url: string;
  state: "open" | "closed";
};

type GhPrJson = {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
};

export class GitHubService {
  async getPullRequest(
    projectPath: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    const { stdout } = await execa(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,title,url,state,headRefName,baseRefName",
      ],
      { cwd: projectPath },
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
}
