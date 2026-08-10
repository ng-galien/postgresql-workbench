export const DEBUG_SESSION_STATUS_EVENT = "plpgsql/sessionStatus";

export type DebugSessionRuntimeState =
  | "preparing"
  | "waitingForTarget"
  | "suspended"
  | "resuming"
  | "terminating"
  | "terminated"
  | "failed";

export interface DebugSessionRoutine {
  oid: number;
  schema: string | null;
  name: string;
  kind: "function" | "procedure";
}

export interface DebugSessionSource {
  name: string;
  path: string;
  line: number;
}

/**
 * Correlated runtime state emitted by the adapter.
 *
 * `sessionId` is also embedded in the PostgreSQL listener and target
 * `application_name`, allowing the extension to join DAP and pg_stat_activity
 * observations without guessing from backend timing.
 */
export interface DebugSessionStatus {
  sessionId: string;
  state: DebugSessionRuntimeState;
  timestamp: string;
  routine?: DebugSessionRoutine;
  query?: string;
  listenerPid?: number;
  targetPid?: number;
  source?: DebugSessionSource;
  message?: string;
}
