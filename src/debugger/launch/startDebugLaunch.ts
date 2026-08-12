import { Client, type ClientConfig } from "pg";
import type { SyntaxParser } from "../../analysis/syntaxTree.js";
import { PostgresDebugger } from "../postgres/index.js";
import { runBoundedQuery } from "./boundedQueryResult.js";
import { debugApplicationName } from "./debugApplicationName.js";
import type { DebugResult, DebugResultSource } from "./debugResult.js";
import {
  type LaunchTargetArguments,
  resolveTargetExecution,
  type TargetExecution,
} from "./resolveTarget.js";

export interface DebugLaunchArguments extends LaunchTargetArguments {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | "require" | "prefer" | "disable";
}

export interface DebugLaunchHooks {
  listenerReady(debuggerBackend: PostgresDebugger): void;
  entryResolved(entryOid: number): void;
  targetClientReady(client: Client): void;
  replayFunctionBreakpoints(): Promise<void>;
  listenerError(error: Error): void;
  targetError(error: Error): void;
  notice(severity: string, message: string): void;
}

export interface PreparedDebugLaunch {
  debuggerBackend: PostgresDebugger;
  targetClient: Client;
  targetPid: number;
  pgConfig: ClientConfig;
  execution: TargetExecution;
}

export interface RunningDebugTarget {
  query: Promise<void>;
  ready: Promise<void>;
}

export class DebugLaunchError extends Error {
  constructor(
    readonly responseCode: number,
    message: string,
  ) {
    super(message);
  }
}

function postgresConfig(args: DebugLaunchArguments): ClientConfig {
  const useSsl = args.ssl === true || args.ssl === "require" || args.ssl === "prefer";
  return {
    host: args.host,
    port: args.port,
    database: args.database,
    user: args.user,
    password: args.password ?? "",
    connectionTimeoutMillis: 10_000,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

function configureTargetResultTypeParsers(client: Client): void {
  client.setTypeParser(17, (value) => value);
  client.setTypeParser(114, (value) => value);
  client.setTypeParser(3802, (value) => value);
}

export async function prepareDebugLaunch(
  args: DebugLaunchArguments,
  sessionSuffix: string,
  hooks: DebugLaunchHooks,
  getParser: () => Promise<SyntaxParser>,
): Promise<PreparedDebugLaunch> {
  const pgConfig = postgresConfig(args);
  const listenerClient = new Client({
    ...pgConfig,
    application_name: debugApplicationName("listener", sessionSuffix),
  });
  let targetClient: Client | undefined;

  try {
    await listenerClient.connect();
    listenerClient.on("error", hooks.listenerError);
    const debuggerBackend = new PostgresDebugger(listenerClient);
    hooks.listenerReady(debuggerBackend);

    const diagnostic = await debuggerBackend.checkDebugger();
    if (!diagnostic.sharedLibraryOk) {
      throw new DebugLaunchError(1, "plugin_debugger not in shared_preload_libraries");
    }
    if (!diagnostic.extensionOk) {
      throw new DebugLaunchError(2, "pldbgapi extension not installed");
    }

    await debuggerBackend.createListener();
    const execution = await resolveTargetExecution(
      debuggerBackend,
      args,
      args.routine ? undefined : await getParser(),
    );
    hooks.entryResolved(execution.entryOid);
    await listenerClient.query("SELECT set_config('application_name', $1, false)", [
      debugApplicationName("listener", sessionSuffix, execution.entryOid),
    ]);
    try {
      await debuggerBackend.setGlobalBreakpoint(execution.entryOid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("another debugger")) {
        throw new DebugLaunchError(
          5,
          "Another PL/pgSQL debug session already owns this routine breakpoint. " +
            "Stop that session or wait for it to finish, then retry. The active session was not interrupted.",
        );
      }
      throw error;
    }

    await hooks.replayFunctionBreakpoints();
    targetClient = new Client({
      ...pgConfig,
      application_name: debugApplicationName("target", sessionSuffix, execution.entryOid),
    });
    configureTargetResultTypeParsers(targetClient);
    hooks.targetClientReady(targetClient);
    await targetClient.connect();
    targetClient.on("error", hooks.targetError);
    targetClient.on("notice", (notice) =>
      hooks.notice(notice.severity ?? "NOTICE", notice.message ?? ""),
    );
    const targetPid = (targetClient as Client & { processID?: number | null }).processID ?? 0;
    return { debuggerBackend, targetClient, targetPid, pgConfig, execution };
  } catch (error) {
    await targetClient?.end().catch(() => undefined);
    await listenerClient.end().catch(() => undefined);
    throw error;
  }
}

export function startDebugTarget(
  prepared: PreparedDebugLaunch,
  options: {
    attachTimeoutMs: number;
    resultId: string;
    resultLabel: string;
    resultSource?: DebugResultSource;
    resultTimestamp: string;
    maxResultRows: number;
  },
  targetSqlResult: (result: DebugResult) => void,
  targetSqlError: (error: Error) => void,
  targetEnded: () => void,
): RunningDebugTarget {
  let rejectTargetFailed: (error: Error) => void;
  const targetFailed = new Promise<never>((_, reject) => {
    rejectTargetFailed = reject;
  });
  let reachedTarget = false;
  const query = runBoundedQuery(
    prepared.targetClient,
    prepared.execution.queryText,
    prepared.execution.queryValues,
    {
      id: options.resultId,
      label: options.resultLabel,
      source: options.resultSource,
      timestamp: options.resultTimestamp,
      maxRows: options.maxResultRows,
    },
  )
    .then(
      (result) => {
        targetSqlResult(result);
        if (!reachedTarget) {
          rejectTargetFailed(
            new Error(
              `Target SQL completed without reaching the debug entry for ${prepared.execution.queryText.slice(0, 120)} — check that the SQL actually calls the debugged routine`,
            ),
          );
        }
      },
      (error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        targetSqlError(failure);
        rejectTargetFailed(failure);
      },
    )
    .finally(targetEnded);

  const wait = prepared.debuggerBackend.waitForTarget();
  wait.then(
    () => {
      reachedTarget = true;
    },
    () => undefined,
  );
  wait.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Target did not reach ${prepared.execution.queryText.slice(0, 120)} within ${options.attachTimeoutMs / 1000}s — check that the SQL actually calls the debugged routine`,
          ),
        ),
      options.attachTimeoutMs,
    );
    timer.unref?.();
  });
  const ready = Promise.race([wait, targetFailed, timeout])
    .then(() => undefined)
    .finally(() => clearTimeout(timer));
  return { query, ready };
}
