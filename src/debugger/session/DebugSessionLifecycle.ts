export type DebugSessionState =
  | "idle"
  | "preparing"
  | "waitingForTarget"
  | "suspended"
  | "resuming"
  | "terminating"
  | "terminated"
  | "failed";

const ALLOWED_TRANSITIONS: Record<DebugSessionState, ReadonlySet<DebugSessionState>> = {
  idle: new Set(["preparing", "terminating"]),
  preparing: new Set(["waitingForTarget", "terminating"]),
  waitingForTarget: new Set(["suspended", "terminating"]),
  suspended: new Set(["resuming", "terminating"]),
  resuming: new Set(["suspended", "terminating"]),
  terminating: new Set(["terminated", "failed"]),
  terminated: new Set(),
  failed: new Set(),
};

/**
 * Small deterministic lifecycle for one DAP session.
 *
 * PostgreSQL's pldbg step calls block until the next stop, so accepting a
 * second execution command while `resuming` would queue it behind the first
 * command on the same connection and corrupt the DAP event sequence.
 */
export class DebugSessionLifecycle {
  private current: DebugSessionState = "idle";

  get state(): DebugSessionState {
    return this.current;
  }

  transition(next: DebugSessionState): void {
    if (next === this.current) return;
    if (!ALLOWED_TRANSITIONS[this.current].has(next)) {
      throw new Error(`Invalid debug lifecycle transition: ${this.current} -> ${next}`);
    }
    this.current = next;
  }

  beginExecution(): boolean {
    if (this.current !== "suspended") return false;
    this.transition("resuming");
    return true;
  }

  beginTermination(): boolean {
    if (
      this.current === "terminating" ||
      this.current === "terminated" ||
      this.current === "failed"
    ) {
      return false;
    }
    this.transition("terminating");
    return true;
  }

  finishTermination(failed: boolean): void {
    if (this.current !== "terminating") return;
    this.transition(failed ? "failed" : "terminated");
  }
}
