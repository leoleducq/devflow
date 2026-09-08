import { execa } from "execa";
import fs from "fs";

/**
 * DevFlow's side of herdr, the multiplexer whose server owns every agent PTY.
 *
 * DevFlow decides *what* exists (an environment: worktree, database, ports);
 * herdr decides *where it runs* (a workspace per worktree, tabs per agent,
 * persistent across app restarts). Everything here goes through the `herdr`
 * CLI, a thin JSON wrapper over its socket API, so there is no protocol
 * client to maintain for request/response work. Live events are a separate
 * concern, see HerdrEvents.
 *
 * Calls are best-effort at the call sites: herdr may not be installed or its
 * server may be down, and neither must break environment lifecycle.
 */

export type HerdrStatus = {
  installed: boolean;
  /** Server reachable over its socket. */
  running: boolean;
  version?: string;
};

export type HerdrAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

export type HerdrWorkspace = {
  id: string;
  label: string;
  /** Directory of the workspace's first pane, resolved through symlinks. */
  cwd?: string;
  agentStatus: HerdrAgentStatus;
};

export type HerdrAgentKind = "claude" | "pi" | "codex";

export type HerdrAgent = {
  /** Unique live name, the handle for prompt/wait/read. */
  name: string | null;
  /** Canonical agent id herdr detected (claude, pi, ...). */
  agent: string | null;
  status: HerdrAgentStatus;
  paneId: string;
  workspaceId: string;
  cwd: string | null;
};

type AgentInfo = {
  name: string | null;
  agent: string | null;
  agent_status: HerdrAgentStatus;
  pane_id: string;
  cwd: string | null;
};

type Snapshot = {
  workspaces: {
    workspace_id: string;
    label: string;
    agent_status: HerdrAgentStatus;
  }[];
  panes: { workspace_id: string; cwd: string }[];
};

type CliResult<T> = { result: T };

const realpath = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/** herdr rejects agent names outside `[a-z][a-z0-9_-]{0,31}`. */
export const toAgentName = (label: string): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return (slug || "agent").slice(0, 32);
};

const paneWorkspace = (paneId: string) => paneId.split(":")[0] ?? paneId;

const toAgent = (a: AgentInfo): HerdrAgent => ({
  name: a.name,
  agent: a.agent,
  status: a.agent_status,
  paneId: a.pane_id,
  workspaceId: paneWorkspace(a.pane_id),
  cwd: a.cwd,
});

export class HerdrService {
  async status(): Promise<HerdrStatus> {
    let version: string | undefined;
    try {
      const { stdout } = await execa("herdr", ["--version"]);
      version = stdout.trim().replace(/^herdr\s+/, "");
    } catch {
      return { installed: false, running: false };
    }
    try {
      await this.cli<unknown>(["api", "snapshot"]);
      return { installed: true, running: true, version };
    } catch {
      return { installed: true, running: false, version };
    }
  }

  // --- Workspaces -----------------------------------------------------------

  async listWorkspaces(): Promise<HerdrWorkspace[]> {
    const { snapshot } = await this.cli<{ snapshot: Snapshot }>([
      "api",
      "snapshot",
    ]);
    const cwdByWorkspace = new Map<string, string>();
    for (const pane of snapshot.panes) {
      if (!cwdByWorkspace.has(pane.workspace_id))
        cwdByWorkspace.set(pane.workspace_id, realpath(pane.cwd));
    }
    return snapshot.workspaces.map(w => ({
      id: w.workspace_id,
      label: w.label,
      cwd: cwdByWorkspace.get(w.workspace_id),
      agentStatus: w.agent_status,
    }));
  }

  async findWorkspaceAt(cwd: string): Promise<HerdrWorkspace | undefined> {
    const target = realpath(cwd);
    return (await this.listWorkspaces()).find(w => w.cwd === target);
  }

  /**
   * Workspace rooted at `cwd`, created if none exists. Returns its id.
   *
   * Matching is by directory rather than label: the user may rename a
   * workspace in herdr, and two environments never share a worktree.
   */
  async ensureWorkspace(
    cwd: string,
    label: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const existing = await this.findWorkspaceAt(cwd);
    if (existing) return existing.id;

    const envArgs = Object.entries(env).flatMap(([k, v]) => [
      "--env",
      `${k}=${v}`,
    ]);
    const { workspace } = await this.cli<{
      workspace: { workspace_id: string };
    }>([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
      ...envArgs,
    ]);
    return workspace.workspace_id;
  }

  /**
   * Open a git worktree as a workspace (herdr then shows its branch and git
   * status), or return the workspace already on it.
   */
  async openWorktree(checkoutPath: string, label?: string): Promise<string> {
    const existing = await this.findWorkspaceAt(checkoutPath);
    if (existing) return existing.id;
    const args = ["worktree", "open", "--path", checkoutPath, "--no-focus"];
    if (label) args.push("--label", label);
    const { workspace } = await this.cli<{
      workspace: { workspace_id: string };
    }>(args);
    return workspace.workspace_id;
  }

  /**
   * Create a git worktree for `branch` from the repository of `workspaceId`,
   * opened as its own workspace. Returns the new checkout path.
   */
  async createWorktree(
    workspaceId: string,
    branch: string,
    options: { base?: string; label?: string } = {},
  ): Promise<{ workspaceId: string; path: string }> {
    const args = [
      "worktree",
      "create",
      "--workspace",
      workspaceId,
      "--branch",
      branch,
      "--no-focus",
    ];
    if (options.base) args.push("--base", options.base);
    if (options.label) args.push("--label", options.label);
    const { workspace, worktree } = await this.cli<{
      workspace: { workspace_id: string };
      worktree: { path: string };
    }>(args);
    return { workspaceId: workspace.workspace_id, path: worktree.path };
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.cli<unknown>(["workspace", "focus", workspaceId]);
  }

  /** Close every workspace rooted at `cwd`; a no-op when there is none. */
  async closeWorkspacesAt(cwd: string): Promise<void> {
    const target = realpath(cwd);
    const matches = (await this.listWorkspaces()).filter(w => w.cwd === target);
    for (const w of matches) {
      await this.cli<unknown>(["workspace", "close", w.id]);
    }
  }

  /**
   * Display-only tokens for the herdr sidebar (`$devflow_status`, ...), so
   * the multiplexer shows what DevFlow knows about the environment.
   */
  async reportWorkspaceMetadata(
    workspaceId: string,
    tokens: Record<string, string>,
  ): Promise<void> {
    const tokenArgs = Object.entries(tokens).flatMap(([k, v]) => [
      "--token",
      `${k}=${v}`,
    ]);
    await this.cli<unknown>([
      "workspace",
      "report-metadata",
      workspaceId,
      "--source",
      "devflow",
      ...tokenArgs,
    ]);
  }

  // --- Tabs & panes ---------------------------------------------------------

  /** New tab in a workspace, at a shell prompt. Returns the tab's root pane. */
  async createTab(
    workspaceId: string,
    options: { cwd?: string; label?: string; focus?: boolean } = {},
  ): Promise<{ tabId: string; paneId: string }> {
    const args = ["tab", "create", "--workspace", workspaceId];
    if (options.cwd) args.push("--cwd", options.cwd);
    if (options.label) args.push("--label", options.label);
    args.push(options.focus ? "--focus" : "--no-focus");
    const { tab, root_pane } = await this.cli<{
      tab: { tab_id: string };
      root_pane: { pane_id: string };
    }>(args);
    return { tabId: tab.tab_id, paneId: root_pane.pane_id };
  }

  /**
   * Type a command into a pane and press Enter, once its shell is at the
   * prompt. A tab's shell is still sourcing its profile for a moment after
   * creation, and input typed before the prompt is drawn gets lost.
   */
  async runInPane(paneId: string, command: string): Promise<void> {
    await this.waitForShellPrompt(paneId);
    await this.cli<unknown>(["pane", "run", paneId, command]);
  }

  /**
   * Resolve once the pane's shell is the foreground process and a prompt is
   * visible on its last line. Gives up quietly after `timeoutMs`: typing into
   * a slow shell beats never typing at all.
   */
  async waitForShellPrompt(paneId: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous: string | null = null;
    while (Date.now() < deadline) {
      const prompt = await this.visiblePrompt(paneId);
      // The same prompt on two consecutive reads: the shell is done drawing
      // and its line editor is up, so pasted input is decoded properly.
      if (prompt !== null && prompt === previous) return;
      previous = prompt;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  /**
   * The pane's last visible line when it looks like a shell prompt, else null.
   *
   * zsh prints a lone `%` (PROMPT_SP) before it even sources the profile, so
   * a bare prompt symbol is not enough: the line must carry text before it
   * and no escape sequences.
   */
  private async visiblePrompt(paneId: string): Promise<string | null> {
    try {
      const { process_info } = await this.cli<{
        process_info: {
          shell_pid: number | null;
          foreground_processes: { pid: number }[];
        };
      }>(["pane", "process-info", "--pane", paneId]);
      const foreground = process_info.foreground_processes[0]?.pid;
      if (!process_info.shell_pid || foreground !== process_info.shell_pid)
        return null;

      const screen = await this.readPane(paneId, "visible", 5);
      const lastLine = screen.trimEnd().split("\n").pop() ?? "";
      if (/\x1b|\^\[/.test(lastLine)) return null;
      return /\S\s+[%$#>❯]\s*$/.test(lastLine) ? lastLine : null;
    } catch {
      return null;
    }
  }

  async closePane(paneId: string): Promise<void> {
    await this.cli<unknown>(["pane", "close", paneId]);
  }

  // --- Agents ---------------------------------------------------------------

  /**
   * Launch a supported agent in a pane sitting at its shell prompt. Resolves
   * once herdr has detected the agent and it is ready for input.
   */
  async startAgent(
    name: string,
    kind: HerdrAgentKind,
    paneId: string,
    agentArgs: string[] = [],
  ): Promise<HerdrAgent> {
    await this.waitForShellPrompt(paneId);
    const args = ["agent", "start", name, "--kind", kind, "--pane", paneId];
    if (agentArgs.length > 0) args.push("--", ...agentArgs);
    const { agent } = await this.cli<{ agent: AgentInfo }>(args);
    return toAgent(agent);
  }

  /** Submit a prompt; does not wait for the answer. */
  async promptAgent(target: string, text: string): Promise<HerdrAgent> {
    const { agent } = await this.cli<{ agent: AgentInfo }>([
      "agent",
      "prompt",
      target,
      text,
    ]);
    return toAgent(agent);
  }

  async getAgent(target: string): Promise<HerdrAgent | null> {
    try {
      const { agent } = await this.cli<{ agent: AgentInfo }>([
        "agent",
        "get",
        target,
      ]);
      return toAgent(agent);
    } catch {
      return null;
    }
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const { agents } = await this.cli<{ agents: AgentInfo[] }>([
      "agent",
      "list",
    ]);
    return agents.map(toAgent);
  }

  /**
   * Recent output of the agent's pane, soft wraps joined. Unlike the other
   * commands, `agent read` prints the text itself rather than JSON.
   */
  async readAgent(target: string, lines = 120): Promise<string> {
    const { stdout } = await execa("herdr", [
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
      "--format",
      "text",
    ]);
    return stdout;
  }

  /** Pane output as text: `pane read` prints the screen itself, not JSON. */
  private async readPane(
    paneId: string,
    source: "visible" | "recent" | "recent-unwrapped",
    lines: number,
  ): Promise<string> {
    const { stdout } = await execa("herdr", [
      "pane",
      "read",
      paneId,
      "--source",
      source,
      "--lines",
      String(lines),
    ]);
    return stdout;
  }

  /**
   * Run a herdr subcommand and return its JSON result. Some commands (`pane
   * run`, ...) print nothing on success; that is treated as an empty result.
   */
  private async cli<T>(args: string[]): Promise<T> {
    const { stdout } = await execa("herdr", args);
    if (stdout.trim() === "") return undefined as T;
    const parsed = JSON.parse(stdout) as CliResult<T> & {
      error?: { message?: string };
    };
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `herdr ${args[0]} failed`);
    }
    return parsed.result;
  }
}
