import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { runBoundedQuery } from "../../dap/src/debugger/launch/boundedQueryResult.js";
import { PostgresDebugger } from "../../dap/src/debugger/postgres/PostgresDebugger.js";
import type { EvidenceStore, Observation } from "./evidence.js";
import type { DatabaseSessions } from "./sessions.js";

interface DebugRun {
  id: string;
  sessionId: string;
  targetBackendPid: number;
  backend: PostgresDebugger;
  target: Client;
  listener: Client;
  completion: Promise<Observation>;
  state: "starting" | "stopped" | "completed" | "closed";
  timer: NodeJS.Timeout;
}

/** A debug run owns its listener and target; its initial breakpoint is scoped to that target PID. */
export class DebugSessions {
  private readonly runs = new Map<string, DebugRun>();

  constructor(
    private readonly sessions: DatabaseSessions,
    private readonly evidence: EvidenceStore,
  ) {}

  async start(sessionId: string, routineOid: number, sql: string) {
    const sessionContext = this.sessions.context(sessionId);
    return this.sessions.exclusive(sessionId, async () => {
      if (
        [...this.runs.values()].some((run) => run.sessionId === sessionId && run.state !== "closed")
      ) {
        throw new Error("Close the existing debug run before starting another.");
      }
      const listener = await this.sessions.dedicated(sessionId, 0);
      let target: Client | undefined;
      try {
        target = await this.sessions.dedicated(sessionId, 0);
        const backend = new PostgresDebugger(listener);
        const identity = await target.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const context = {
          ...sessionContext,
          backendPid: identity.rows[0]!.pid,
          lane: "debug-target",
        };
        await backend.createListener();
        await backend.setGlobalBreakpoint(routineOid, identity.rows[0]!.pid);
        const id = randomUUID();
        const waiting = backend.waitForTarget();
        const completion = runBoundedQuery(target, sql, [], {
          id,
          singleStatement: true,
          maxRows: 200,
          maxPayloadBytes: 256 * 1024,
        }).then(
          (result) =>
            this.evidence.capture(sessionId, "debug", {
              context,
              debugId: id,
              status: "completed",
              result,
            }),
          (error: Error) =>
            this.evidence.capture(sessionId, "debug", {
              context,
              debugId: id,
              status: "failed",
              sql,
              error: error.message,
            }),
        );
        const run: DebugRun = {
          id,
          sessionId,
          targetBackendPid: identity.rows[0]!.pid,
          backend,
          target,
          listener,
          completion,
          state: "starting",
          timer: setTimeout(() => {
            this.release(id).catch(() => undefined);
          }, 300_000),
        };
        this.runs.set(id, run);
        completion.catch(() => undefined);
        try {
          await deadline(
            Promise.race([
              waiting,
              completion.then(() => {
                throw new Error("Target completed before reaching the selected routine.");
              }),
            ]),
          );
          run.state = "stopped";
          return await this.snapshot(run);
        } catch (error) {
          await this.release(id);
          throw error;
        }
      } catch (error) {
        await Promise.allSettled([listener.end(), target?.end()]);
        throw error;
      }
    });
  }

  async inspect(id: string, frame = 0) {
    const run = this.require(id);
    return this.sessions.exclusive(run.sessionId, async () => {
      if (run.state === "completed") return run.completion;
      const frames = await run.backend.getStack();
      if (!frames.some((entry) => entry.level === frame)) throw new Error("Unknown debug frame.");
      await run.backend.selectFrame(frame);
      return this.snapshot(run);
    });
  }

  async step(id: string, action: "over" | "into" | "continue") {
    const run = this.require(id);
    return this.sessions.exclusive(run.sessionId, async () => {
      if (run.state !== "stopped") throw new Error("Debug run is not stopped.");
      try {
        const step = await deadline(
          action === "over"
            ? run.backend.stepOver()
            : action === "into"
              ? run.backend.stepInto()
              : run.backend.stepContinue(),
        );
        if (!step) {
          run.state = "completed";
          return await deadline(run.completion);
        }
        return await this.snapshot(run);
      } catch (error) {
        await this.release(id);
        throw error;
      }
    });
  }

  async breakpoint(id: string, routineOid: number, line: number, enabled: boolean) {
    const run = this.require(id);
    return this.sessions.exclusive(run.sessionId, async () => ({
      debugId: id,
      changed: enabled
        ? await run.backend.setBreakpoint(routineOid, line)
        : await run.backend.dropBreakpoint(routineOid, line),
    }));
  }

  async release(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.state === "closed") return;
    run.state = "closed";
    clearTimeout(run.timer);
    await Promise.allSettled([run.target.end(), run.listener.end()]);
    this.runs.delete(id);
  }

  async close(id: string): Promise<void> {
    this.require(id);
    await this.release(id);
  }

  async closeSession(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.runs.values()]
        .filter((run) => run.sessionId === sessionId)
        .map((run) => this.release(run.id)),
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.release(id)));
  }

  private require(id: string): DebugRun {
    const run = this.runs.get(id);
    if (!run || run.state === "closed") throw new Error("Unknown or closed debug run.");
    return run;
  }

  private async snapshot(run: DebugRun) {
    const stack = await run.backend.getStack();
    const variables = await run.backend.getVariables();
    const sources = await Promise.all(
      [...new Set(stack.map((frame) => frame.oid))].map((oid) => run.backend.getFunctionDef(oid)),
    );
    return this.evidence.capture(run.sessionId, "debug", {
      debugId: run.id,
      targetBackendPid: run.targetBackendPid,
      status: run.state,
      stack,
      variables,
      sources,
    });
  }
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Debug operation timed out; the debug run was closed.")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
