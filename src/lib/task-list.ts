import { Listr, PRESET_TIMER } from "listr2";
import type { ListrTask } from "listr2";
import { colors } from "./colors.js";
import type { CreateEnvProgress, CreateEnvStepId } from "../services/index.js";

/**
 * Provisioning as a checklist rather than one mutating spinner line.
 *
 * Six steps run behind `devflow provision` — worktree, ports, container,
 * deps, .env, seed — and any of them can be the slow one or the failing one.
 * A single spinner whose text is overwritten shows only the step in flight:
 * when it fails you cannot see what already succeeded, and while it runs you
 * cannot see that `pnpm install` has been going for four minutes. A task list
 * keeps every step on screen with its own state and its own elapsed time.
 *
 * The services already emit `{type:"step", id, status}` events, so this is a
 * pure presentation layer: it turns that stream into task state and never
 * changes what the services do.
 */

/** How the list should be drawn, given how the command was invoked. */
export type TaskRenderMode = "interactive" | "plain" | "silent";

/**
 * A TTY gets the live redrawn list. A pipe gets one plain line per step, so
 * a log or an agent's buffer reads as a sequence rather than as a smear of
 * cursor escapes. `--json` renders nothing at all: the contract is one JSON
 * value on stdout and nothing else.
 */
export const renderMode = (options: {
  json?: boolean;
  quiet?: boolean;
}): TaskRenderMode => {
  if (options.json || options.quiet) return "silent";
  return process.stdout.isTTY && !process.env.CI ? "interactive" : "plain";
};

/**
 * A step of a multi-step run, as the task list drives it: it waits for the
 * service to say the step started, then to say it finished or was skipped.
 */
type StepDefinition = { id: CreateEnvStepId; label: string };

/**
 * Bridges a progress-event stream onto listr2.
 *
 * The work is one long call (`adoptWorktree`, `promoteEnvironment`) that
 * emits events as it goes, not one function per step, so each task cannot
 * simply *be* the step. Instead every task waits on a promise resolved by the
 * matching event, and the whole operation runs alongside the list. A step
 * that never starts because the operation failed earlier is rejected too, so
 * the list terminates instead of hanging on a task that will never resolve.
 */
class StepGate {
  private readonly pending = new Map<
    CreateEnvStepId,
    { resolve: (skipped: boolean) => void; reject: (error: Error) => void }
  >();
  private readonly settled = new Map<CreateEnvStepId, boolean | Error>();
  private started = new Set<CreateEnvStepId>();

  /** Feed one event from the service. */
  handle(event: CreateEnvProgress): void {
    if (event.type !== "step") return;
    if (event.status === "start") {
      this.started.add(event.id);
      return;
    }
    this.finish(event.id, event.status === "skip");
  }

  /** Fail every step still waiting, when the operation itself threw. */
  abort(error: Error): void {
    for (const [id, waiter] of this.pending) {
      this.settled.set(id, error);
      waiter.reject(error);
    }
    this.pending.clear();
    this.aborted = error;
  }

  /**
   * Settle every step the operation never mentioned, once it has returned.
   *
   * A service is free to emit fewer events than there are steps — adopting an
   * already-registered checkout only ever reports `worktree`, and a LITE run
   * skips the resources entirely. Those tasks would otherwise wait on an
   * event that is never coming, and listr2 would never finish, taking the
   * command's own output with it. Anything still outstanding when the work is
   * done was, by definition, not needed.
   */
  complete(): void {
    for (const [id, waiter] of this.pending) {
      this.settled.set(id, true);
      waiter.resolve(true);
    }
    this.pending.clear();
    this.finished = true;
  }

  private aborted: Error | null = null;
  private finished = false;

  private finish(id: CreateEnvStepId, skipped: boolean): void {
    const waiter = this.pending.get(id);
    if (waiter) {
      this.pending.delete(id);
      waiter.resolve(skipped);
    }
    this.settled.set(id, skipped);
  }

  /** Resolves true when the step was skipped, false when it really ran. */
  wait(id: CreateEnvStepId): Promise<boolean> {
    const already = this.settled.get(id);
    if (already instanceof Error) return Promise.reject(already);
    if (already !== undefined) return Promise.resolve(already);
    if (this.aborted) return Promise.reject(this.aborted);
    // The work is already over, so this step is one it never needed to run.
    if (this.finished) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

export type TaskListResult<T> = T;

/**
 * Run `operation` while showing `steps` as a live checklist.
 *
 * The operation's own result is what comes back; the list is only how the run
 * is displayed. Errors propagate unchanged so the caller's `failCommand` and
 * the `--json` error shape stay in charge of reporting.
 */
export async function runSteps<T>(options: {
  steps: readonly StepDefinition[];
  title?: string;
  mode: TaskRenderMode;
  /** Receives the progress callback to hand to the service. */
  operation: (onProgress: (event: CreateEnvProgress) => void) => Promise<T>;
}): Promise<T> {
  const { steps, mode, operation } = options;

  if (mode === "silent") {
    return operation(() => {});
  }

  const gate = new StepGate();
  let operationError: Error | null = null;

  // Start the work immediately: the list is an observer, and holding the
  // operation until listr2 has rendered would only add latency.
  const work = operation(event => gate.handle(event)).then(
    value => {
      // Steps the service never reported were not needed; release them so
      // the list can finish rather than wait on events that will not come.
      gate.complete();
      return value;
    },
    (error: unknown) => {
      const wrapped =
        error instanceof Error ? error : new Error(String(error));
      operationError = wrapped;
      gate.abort(wrapped);
      throw wrapped;
    },
  );
  // The list reports the failure through the failing task; without this the
  // rejection would also surface as an unhandled rejection.
  work.catch(() => {});

  const tasks: ListrTask[] = steps.map(step => ({
    title: step.label,
    task: async (_ctx, task) => {
      const skipped = await gate.wait(step.id);
      // listr2 prefixes the title itself, so the reason alone reads right.
      if (skipped) task.skip("not needed");
    },
  }));

  const list = new Listr(tasks, {
    // `simple` prints one line per step with no cursor movement, which is
    // what a pipe or a CI log wants; `default` is the live redraw.
    renderer: mode === "interactive" ? "default" : "simple",
    rendererOptions: {
      collapseSubtasks: false,
      timer: PRESET_TIMER,
    },
    exitOnError: true,
    // The command prints its own error; listr2 re-throwing it here would
    // report it twice.
    registerSignalListeners: false,
  });

  try {
    await list.run();
  } catch {
    // The operation's own error is the useful one — a task failing is only
    // this list's echo of it.
  }

  // Always await the real work: it carries the result and the true error.
  const result = await work;
  if (operationError) throw operationError;
  return result;
}

/** A one-line success note, matching the task list's visual weight. */
export const noteSuccess = (message: string): void => {
  console.log(`${colors.green("✔")} ${message}`);
};
