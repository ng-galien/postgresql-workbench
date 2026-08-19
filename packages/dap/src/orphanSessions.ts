import type { Client } from "pg";
import { parseDebugApplicationName } from "./debugger/launch/debugApplicationName.js";
import type {
  DebugSessionRoutine,
  DebugSessionRuntimeState,
  DebugSessionStatus,
} from "./debugger/launch/debugSessionStatus.js";

interface DebugRoutineRow {
  oid: string | number;
  schema: string;
  name: string;
  kind: "function" | "procedure";
}

interface DebugBackendRow {
  pid: number;
  application_name: string;
  usename: string;
  client_addr: string | null;
  state: string | null;
  backend_start: Date | string;
  state_change: Date | string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  query: string | null;
  owned_by_current_user: boolean;
}

export interface DebugBackend {
  pid: number;
  role: "listener" | "target";
  applicationName: string;
  routineOid?: number;
  user: string;
  clientAddress?: string;
  state: string;
  stateChangedAt?: Date;
  waitEvent?: string;
  query?: string;
  ownedByCurrentUser: boolean;
}

export type DebugSessionObservedState = DebugSessionRuntimeState | "incomplete" | "unknown";

export interface DebugSessionInfo {
  id: string;
  startedAt: Date;
  backends: DebugBackend[];
  state: DebugSessionObservedState;
  stateSource: "adapter" | "database";
  routineOid?: number;
  routine?: DebugSessionRoutine;
  query?: string;
}

export interface DebugSessionTermination {
  sessionId: string;
  role: "listener" | "target";
  pid?: number;
  applicationName: string;
  status: "terminated" | "terminationRequested" | "alreadyGone" | "denied" | "failed";
  error?: string;
}

export interface DebugBackendSelection {
  sessionId: string;
  role: "listener" | "target";
  pid: number;
  applicationName: string;
}

export async function listDebugSessions(client: Client): Promise<DebugSessionInfo[]> {
  const result = await client.query<DebugBackendRow>(`
    SELECT
      pid,
      application_name,
      usename,
      client_addr::text AS client_addr,
      state,
      backend_start,
      state_change,
      wait_event_type,
      wait_event,
      query,
      usename = current_user AS owned_by_current_user
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND (
        left(application_name, length('plpgsql_dap_listener_')) = 'plpgsql_dap_listener_'
        OR left(application_name, length('plpgsql_dap_target_')) = 'plpgsql_dap_target_'
      )
    ORDER BY backend_start, pid
  `);

  const sessions = new Map<string, DebugSessionInfo>();
  for (const row of result.rows) {
    const identity = parseDebugApplicationName(row.application_name);
    if (!identity) continue;
    const startedAt = new Date(row.backend_start);
    const session = sessions.get(identity.sessionId) ?? {
      id: identity.sessionId,
      startedAt,
      backends: [],
      state: "unknown" as const,
      stateSource: "database" as const,
    };
    if (startedAt < session.startedAt) session.startedAt = startedAt;
    if (identity.routineOid && (identity.role === "target" || session.routineOid === undefined)) {
      session.routineOid = identity.routineOid;
    }
    session.backends.push({
      pid: row.pid,
      role: identity.role,
      applicationName: row.application_name,
      routineOid: identity.routineOid,
      user: row.usename,
      clientAddress: row.client_addr ?? undefined,
      state: row.state ?? "unknown",
      stateChangedAt: row.state_change ? new Date(row.state_change) : undefined,
      waitEvent:
        row.wait_event_type && row.wait_event
          ? `${row.wait_event_type}: ${row.wait_event}`
          : undefined,
      query: row.query?.replace(/\s+/g, " ").trim() || undefined,
      ownedByCurrentUser: row.owned_by_current_user,
    });
    sessions.set(identity.sessionId, session);
  }

  const recovered = [...sessions.values()]
    .map((session) => {
      const target = session.backends.find((backend) => backend.role === "target");
      return {
        ...session,
        state: inferDatabaseSessionState(session.backends),
        query: target?.query,
      };
    })
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  const routines = await loadDebugRoutines(
    client,
    recovered.flatMap((session) => (session.routineOid ? [session.routineOid] : [])),
  );
  return recovered.map((session) => ({
    ...session,
    ...(session.routineOid && routines.has(session.routineOid)
      ? { routine: routines.get(session.routineOid) }
      : {}),
  }));
}

async function loadDebugRoutines(
  client: Client,
  routineOids: readonly number[],
): Promise<Map<number, DebugSessionRoutine>> {
  const uniqueOids = [...new Set(routineOids)];
  if (uniqueOids.length === 0) return new Map();
  const result = await client.query<DebugRoutineRow>(
    `
      SELECT
        p.oid::text AS oid,
        n.nspname AS schema,
        p.proname AS name,
        CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = ANY($1::oid[])
    `,
    [uniqueOids],
  );
  return new Map(
    result.rows.map((row) => [
      Number(row.oid),
      {
        oid: Number(row.oid),
        schema: row.schema,
        name: row.name,
        kind: row.kind,
      },
    ]),
  );
}

function inferDatabaseSessionState(backends: readonly DebugBackend[]): DebugSessionObservedState {
  const listener = backends.find((backend) => backend.role === "listener");
  const target = backends.find((backend) => backend.role === "target");
  if (!listener || !target) return "incomplete";

  const listenerQuery = listener.query?.toLowerCase() ?? "";
  if (listenerQuery.includes("pldbg_wait_for_target")) return "waitingForTarget";
  if (
    listenerQuery.includes("pldbg_continue") ||
    listenerQuery.includes("pldbg_step_into") ||
    listenerQuery.includes("pldbg_step_over")
  ) {
    return "resuming";
  }
  if (listener.state === "idle" && target.state === "active") return "suspended";
  return "unknown";
}

/** Joins exact adapter state to the PostgreSQL sessions carrying the same suffix. */
export function enrichDebugSessions(
  sessions: readonly DebugSessionInfo[],
  statuses: readonly DebugSessionStatus[],
): DebugSessionInfo[] {
  const byId = new Map(statuses.map((status) => [status.sessionId, status]));
  return sessions.map((session) => {
    const status = byId.get(session.id);
    if (!status) return session;
    return {
      ...session,
      state: status.state,
      stateSource: "adapter",
      routineOid: status.routine?.oid ?? session.routineOid,
      routine: status.routine,
      query: status.query ?? session.query,
    };
  });
}

function terminationErrorStatus(error: unknown): "denied" | "failed" {
  return (error as { code?: string })?.code === "42501" ? "denied" : "failed";
}

async function waitForBackendExit(
  client: Client,
  pid: number,
  applicationName: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await client.query(
      `
        SELECT 1
        FROM pg_stat_activity
        WHERE pid = $1
          AND datname = current_database()
          AND application_name = $2
      `,
      [pid, applicationName],
    );
    if (result.rows.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Terminates one PID after revalidating its database and exact DAP application name. */
async function terminateDebugBackend(
  client: Client,
  sessionId: string,
  role: "listener" | "target",
  applicationName: string,
  pid: number,
): Promise<DebugSessionTermination> {
  try {
    const result = await client.query<{ terminated: boolean }>(
      `
        SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_stat_activity
        WHERE pid = $1
          AND datname = current_database()
          AND pid <> pg_backend_pid()
          AND application_name = $2
      `,
      [pid, applicationName],
    );
    if (result.rows.length === 0) {
      return { sessionId, role, applicationName, status: "alreadyGone" };
    }
    if (!result.rows[0].terminated) {
      return { sessionId, role, pid, applicationName, status: "failed" };
    }
    const exited = await waitForBackendExit(client, pid, applicationName);
    return {
      sessionId,
      role,
      pid,
      applicationName,
      status: exited ? "terminated" : "terminationRequested",
    };
  } catch (error) {
    return {
      sessionId,
      role,
      pid,
      applicationName,
      status: terminationErrorStatus(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Terminates exact DAP application names independently. Every PID is
 * revalidated at kill time, and missing or unauthorized backends are reported
 * without hiding successful terminations from the same selection.
 */
export async function terminateDebugSessions(
  client: Client,
  selections: readonly DebugBackendSelection[],
): Promise<DebugSessionTermination[]> {
  const uniqueSelections = [
    ...new Map(
      selections.map((selection) => [`${selection.pid}:${selection.applicationName}`, selection]),
    ).values(),
  ];
  if (uniqueSelections.length === 0) return [];

  const terminations: DebugSessionTermination[] = [];
  for (const selection of uniqueSelections) {
    terminations.push(
      await terminateDebugBackend(
        client,
        selection.sessionId,
        selection.role,
        selection.applicationName,
        selection.pid,
      ),
    );
  }
  return terminations;
}

export function debugBackendSelections(
  sessions: readonly DebugSessionInfo[],
): DebugBackendSelection[] {
  return sessions.flatMap((session) =>
    session.backends.map((backend) => ({
      sessionId: session.id,
      role: backend.role,
      pid: backend.pid,
      applicationName: backend.applicationName,
    })),
  );
}
