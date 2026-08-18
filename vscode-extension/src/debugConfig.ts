import type { ParsedCall } from "../../src/callParser.js";
import {
  type DebugLaunchRoutineArgument,
  type DebugLaunchRoutineTarget,
  type DebugResultSource,
  routineDisplayName,
} from "../../src/debugger/launch/index.js";
import { getConnectionName, type ServerConfig } from "./serverStore.js";
import type { FunctionDefinition } from "./sqlCodeLensProvider.js";

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
  server?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | "require" | "prefer" | "disable";
  [key: string]: unknown;
}

export interface DebugConfigUi {
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors VS Code UI methods and lightweight test doubles
  showErrorMessage(message: string): void | PromiseLike<unknown>;
  showInputBox?(options: {
    prompt: string;
    placeHolder?: string;
    ignoreFocusOut?: boolean;
  }): Thenable<string | undefined>;
}

export interface DebugConfigLogger {
  appendLine(message: string): void;
}

export interface DebugConfigConnectionStore {
  get(id: string): ServerConfig | undefined;
}

export interface DebugConfigConnectionManager {
  store: DebugConfigConnectionStore;
  connectedServerIds: readonly string[];
  commands: { pickConnection(): Promise<string | undefined> };
  isServerConnected(id: string): boolean;
  connectServer(id: string): Promise<boolean>;
  refreshDebugCapability(
    serverId: string,
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
    config.sql = sql.trim();
    if (!config.name || config.name === "Debug PL/pgSQL") {
      config.name = await configNameFromSql(config.sql, parseTarget);
    }
  }

  if (config.host && config.password !== undefined) {
    out?.appendLine(
      `resolveDebugConfiguration: inline connection ${config.host}:${config.port}/${config.database}`,
    );
    return config;
  }

  const serverId = config.server;
  let server = serverId
    ? cm.store.get(serverId)
    : cm.connectedServerIds.length === 1
      ? cm.store.get(cm.connectedServerIds[0])
      : undefined;

  if (serverId && !server) {
    await ui.showErrorMessage(
      "The saved Connexion for this debug target no longer exists. Choose the Association again.",
    );
    return undefined;
  }
  if (!server) {
    const picked = await cm.commands.pickConnection();
    if (!picked) return undefined;
    server = cm.store.get(picked);
    if (!server) return undefined;
  }

  if (!cm.isServerConnected(server.id)) {
    const ok = await cm.connectServer(server.id);
    if (!ok) return undefined;
  }

  const capability = await cm.refreshDebugCapability(server.id);
  if (!capability?.available) {
    await ui.showErrorMessage(
      `${getConnectionName(server)}: PL/pgSQL debugging is unavailable. ${capability?.error || "The debugger capability could not be verified."}`,
    );
    return undefined;
  }

  config.server = server.id;
  const password = await cm.getPassword(server.id);
  config.host = server.host;
  config.port = server.port;
  config.database = server.database;
  config.user = server.user;
  config.password = password;
  if (server.ssl) config.ssl = server.ssl;

  out?.appendLine(`resolveDebugConfiguration: ${getConnectionName(server)}`);
  return config;
}
