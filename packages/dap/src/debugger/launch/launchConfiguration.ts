/**
 * Turning a routine or a SQL call into a complete launch configuration: naming the session,
 * choosing the Connection, verifying the debugger capability, and inlining the credentials the
 * DAP server needs. The host supplies its Connections and UI through the ports declared here.
 */
import type { FunctionDefinition, ParsedCall } from "../../../../sql/src/callParser.js";
import type { DebugResultSource } from "./debugResult.js";
import {
  type DebugLaunchRoutineArgument,
  type DebugLaunchRoutineTarget,
  routineDisplayName,
} from "./launchConfig.js";

export interface DebugConfigurationLike {
  type?: string;
  request?: string;
  name?: string;
  sql?: string;
  entryRoutine?: DebugLaunchRoutineTarget;
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  sourceUris?: Record<string, string>;
  resultLabel?: string;
  resultSource?: DebugResultSource;
  stopOnEntry?: boolean;
  connection?: string;
  /** Historical persisted launch.json key; normalized to `connection` before resolution. */
  server?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  [key: string]: unknown;
}

export interface DebugConfigUi {
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors VS Code UI methods and lightweight test doubles
  showErrorMessage(message: string): void | PromiseLike<unknown>;
  showInputBox?(options: {
    prompt: string;
    placeHolder?: string;
    ignoreFocusOut?: boolean;
  }): PromiseLike<string | undefined>;
}

export interface DebugConfigLogger {
  appendLine(message: string): void;
}

/** The saved-Connection fields a debug launch reads; the host's richer Connection satisfies it. */
export interface DebugLaunchConnection {
  id: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
}

export interface DebugConfigConnectionManager {
  /** The saved Connection, when it still exists. */
  connection(id: string): DebugLaunchConnection | undefined;
  connectedConnectionIds: readonly string[];
  pickConnection(): Promise<string | undefined>;
  /** How the host presents this Connection in messages. */
  describeConnection(id: string): string;
  isConnectionConnected(id: string): boolean;
  connectConnection(id: string): Promise<boolean>;
  refreshDebugCapability(
    connectionId: string,
  ): Promise<{ available: boolean; error: string } | undefined>;
  getPassword(id: string): Promise<string>;
}

export type SqlTargetParser = (sql: string) => Promise<ParsedCall>;

export function configNameFromRoutine(target: DebugLaunchRoutineTarget): string {
  return `Debug ${routineDisplayName(target)}`;
}

export async function configNameFromSql(
  sql: string,
  parseTarget?: SqlTargetParser,
): Promise<string> {
  if (!parseTarget) return "Debug PL/pgSQL";
  try {
    const parsed = await parseTarget(sql);
    if (!parsed.routine) return "Debug PL/pgSQL";
    return `Debug ${parsed.schema ? `${parsed.schema}.` : ""}${parsed.routine}`;
  } catch {
    return "Debug PL/pgSQL";
  }
}

export function buildRoutineTarget(
  def: FunctionDefinition,
  extras: Partial<DebugLaunchRoutineTarget> = {},
): DebugLaunchRoutineTarget {
  return {
    schema: def.schema,
    name: def.name,
    kind: def.kind,
    argTypes: def.params.map((param) => param.type),
    ...extras,
  };
}

export function buildRoutineArgs(values: string[]): DebugLaunchRoutineArgument[] {
  return values.map((value) => ({
    value: value.trim().toUpperCase() === "NULL" ? null : value,
  }));
}

export async function resolveDebugConfiguration(
  config: DebugConfigurationLike,
  cm: DebugConfigConnectionManager,
  ui: DebugConfigUi,
  parseTarget?: SqlTargetParser,
  out?: DebugConfigLogger,
): Promise<DebugConfigurationLike | undefined> {
  out?.appendLine(
    `resolveDebugConfiguration called: type=${config.type} sql=${config.sql?.slice(0, 40)}`,
  );

  if (!config.type) config.type = "postgresql-workbench";
  if (!config.request) config.request = "launch";
  if (config.stopOnEntry === undefined) config.stopOnEntry = true;
  if (!config.name) {
    config.name = config.routine
      ? configNameFromRoutine(config.routine)
      : config.entryRoutine
        ? configNameFromRoutine(config.entryRoutine)
        : config.sql
          ? await configNameFromSql(config.sql, parseTarget)
          : "Debug PL/pgSQL";
  }

  if (!config.sql && !config.routine && !config.entryRoutine) {
    const sql = await ui.showInputBox?.({
      prompt: "SQL statement to debug",
      placeHolder: "SELECT my_function(...)  or  CALL my_procedure(...)",
      ignoreFocusOut: true,
    });
    if (!sql?.trim()) {
      await ui.showErrorMessage(
        "No launch target to debug. Use CodeLens or set 'sql' or 'routine' in launch.json.",
      );
      return undefined;
    }
    const statement = sql.trim();
    config.sql = statement;
    if (!config.name || config.name === "Debug PL/pgSQL") {
      config.name = await configNameFromSql(statement, parseTarget);
    }
  }

  if (config.host && config.password !== undefined) {
    out?.appendLine(
      `resolveDebugConfiguration: inline connection ${config.host}:${config.port}/${config.database}`,
    );
    return config;
  }

  const connectionId = config.connection ?? config.server;
  if (connectionId) config.connection = connectionId;
  delete config.server;
  let connection = connectionId
    ? cm.connection(connectionId)
    : cm.connectedConnectionIds.length === 1
      ? cm.connection(cm.connectedConnectionIds[0])
      : undefined;

  if (connectionId && !connection) {
    await ui.showErrorMessage(
      "The saved Connection for this debug target no longer exists. Choose the Association again.",
    );
    return undefined;
  }
  if (!connection) {
    const picked = await cm.pickConnection();
    if (!picked) return undefined;
    connection = cm.connection(picked);
    if (!connection) return undefined;
  }

  if (!cm.isConnectionConnected(connection.id)) {
    const ok = await cm.connectConnection(connection.id);
    if (!ok) return undefined;
  }

  const capability = await cm.refreshDebugCapability(connection.id);
  if (!capability?.available) {
    await ui.showErrorMessage(
      `${cm.describeConnection(connection.id)}: PL/pgSQL debugging is unavailable. ${capability?.error || "The debugger capability could not be verified."}`,
    );
    return undefined;
  }

  config.connection = connection.id;
  const password = await cm.getPassword(connection.id);
  config.host = connection.host;
  config.port = connection.port;
  config.database = connection.database;
  config.user = connection.user;
  config.password = password;
  if (connection.ssl) config.ssl = connection.ssl;

  out?.appendLine(`resolveDebugConfiguration: ${cm.describeConnection(connection.id)}`);
  return config;
}
