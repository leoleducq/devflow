import { LinearClient } from "@linear/sdk";

type LinearLabel = {
  name: string;
  color: string;
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  branchName: string;
  url: string;
  state: string;
  assignee: string | null;
  labels: LinearLabel[];
  priority: number;
  createdAt: string;
};

type ListIssuesOptions = {
  teamId: string;
  projectId?: string;
  excludeStates?: string[];
  filterLabels?: string[];
};

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  branchName: string;
  url: string;
  priority: number;
  createdAt: string;
  state: { name: string } | null;
  assignee: { name: string } | null;
  labels: { nodes: LinearLabel[] };
};

export class LinearService {
  private client: LinearClient;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async createProject(teamId: string, name: string): Promise<string> {
    const project = await this.client.createProject({
      teamIds: [teamId],
      name,
    });
    const created = await project.project;
    if (!created) throw new Error("Failed to create Linear project");
    return created.id;
  }

  async listTeams(): Promise<{ id: string; name: string; key: string }[]> {
    const teams = await this.client.teams();
    return teams.nodes.map(t => ({ id: t.id, name: t.name, key: t.key }));
  }

  /**
   * The team's projects, so `devflow project linear --project` can accept a
   * name a human would recognise rather than only a UUID.
   */
  async listProjects(
    teamId: string,
  ): Promise<{ id: string; name: string }[]> {
    const projects = await this.client.projects({ first: 250 });
    const nodes = await Promise.all(
      projects.nodes.map(async project => {
        const teams = await project.teams();
        return teams.nodes.some(team => team.id === teamId)
          ? { id: project.id, name: project.name }
          : null;
      }),
    );
    return nodes.filter((p): p is { id: string; name: string } => p !== null);
  }

  async listLabels(
    teamId: string,
  ): Promise<{ id: string; name: string; color: string }[]> {
    const labels = await this.client.issueLabels({
      filter: {
        team: { id: { eq: teamId } },
      },
      first: 100,
    });
    return labels.nodes.map(l => ({ id: l.id, name: l.name, color: l.color }));
  }

  async listIssues(options: ListIssuesOptions): Promise<LinearIssue[]> {
    const {
      teamId,
      projectId,
      excludeStates = [],
      filterLabels = [],
    } = options;

    const filter: Record<string, unknown> = {
      team: { id: { eq: teamId } },
      state: {
        type: { nin: ["completed", "canceled"] },
        ...(excludeStates.length > 0 && { name: { nin: excludeStates } }),
      },
    };
    if (projectId) {
      filter.project = { id: { eq: projectId } };
    }
    if (filterLabels.length > 0) {
      filter.labels = { name: { in: filterLabels } };
    }

    // Single GraphQL request with relations inlined — the SDK's lazy
    // issue.state/assignee/labels() would fire ~3 requests per issue.
    const { data } = await this.client.client.rawRequest<
      { issues: { nodes: IssueNode[] } },
      { filter: Record<string, unknown>; first: number }
    >(
      `query ListIssues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            identifier
            title
            branchName
            url
            priority
            createdAt
            state { name }
            assignee { name }
            labels { nodes { name color } }
          }
        }
      }`,
      { filter, first: 250 },
    );

    return (data?.issues.nodes ?? []).map(issue => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      branchName: issue.branchName,
      url: issue.url,
      state: issue.state?.name ?? "Unknown",
      assignee: issue.assignee?.name ?? null,
      labels: issue.labels.nodes.map(l => ({ name: l.name, color: l.color })),
      priority: issue.priority,
      createdAt: issue.createdAt,
    }));
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    const issue = await this.client.issue(issueId);
    const state = await issue.state;
    const assignee = await issue.assignee;
    const labels = await issue.labels();
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      branchName: issue.branchName,
      url: issue.url,
      state: state?.name ?? "Unknown",
      assignee: assignee?.name ?? null,
      labels: labels.nodes.map(l => ({ name: l.name, color: l.color })),
      priority: issue.priority,
      createdAt: issue.createdAt.toISOString(),
    };
  }
}
