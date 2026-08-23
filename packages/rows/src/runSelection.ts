import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { runBoundedQuery } from "../../dap/src/debugger/launch/boundedQueryResult.js";
import {
  createDebugResultContext,
  DEBUG_RESULT_LIMITS,
  type DebugResult,
  type DebugResultError,
  type DebugResultSource,
  type DebugResultStatus,
} from "../../dap/src/debugger/launch/index.js";
import type { SqlStatementCount } from "../../sql/src/analysis/sqlStatements.js";
import { isPostgresSqlLanguage } from "../../sql/src/text/documentLanguage.js";

export interface SqlEditorSelection {
  languageId: string;
  documentText: string;
  selectionStart: number;
  selectionEnd: number;
  source?: DebugResultSource;
}

export type PreparedSqlSelection =
  | { status: "ready"; sql: string; source?: DebugResultSource }
  | { status: "empty-selection" }
  | { status: "unsupported-language" };

export interface SqlResultSink {
  add(result: DebugResult): void;
  addStatus(status: DebugResultStatus): void;
}

export interface ExecuteSqlSelectionOptions {
  maxRows: number;
  classifyStatementCount(sql: string): Promise<SqlStatementCount>;
  id?: string;
  timestamp?: string;
  now?: () => number;
  onStarted?: () => void;
}

export interface SqlExecutionRejected {
  status: "multiple-statements" | "unclassifiable";
}

export function prepareSqlSelection(input: SqlEditorSelection): PreparedSqlSelection {
  if (!isPostgresSqlLanguage(input.languageId)) {
    return { status: "unsupported-language" };
  }
  const start = Math.max(0, Math.min(input.documentText.length, input.selectionStart));
  const end = Math.max(start, Math.min(input.documentText.length, input.selectionEnd));
  const sql = input.documentText.slice(start, end);
  if (!sql.trim()) {
    return { status: "empty-selection" };
  }
  return {
    status: "ready",
    sql,
    ...(input.source ? { source: input.source } : {}),
  };
}

export async function executeSqlSelection(
  client: Client,
  selection: Extract<PreparedSqlSelection, { status: "ready" }>,
  sink: SqlResultSink,
  options: ExecuteSqlSelectionOptions,
): Promise<DebugResult | DebugResultError | SqlExecutionRejected> {
  const statementCount = await options.classifyStatementCount(selection.sql);
  if (statementCount !== "single-statement") return { status: statementCount };
  const now = options.now ?? Date.now;
  const startedAt = now();
  const id = options.id ?? `sql-${randomUUID()}`;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const sourceLabel = selection.source
    ? `${selection.source.name}${selection.source.line ? `:${selection.source.line}` : ""}`
    : undefined;
  const context = createDebugResultContext(
    sourceLabel ? `SQL · ${sourceLabel}` : "SQL selection",
    selection.sql,
    selection.source,
  );
  sink.addStatus({
    id,
    status: "pending",
    ...context,
    timestamp,
  });
  options.onStarted?.();
  try {
    const result = await runBoundedQuery(client, selection.sql, [], {
      id,
      label: context.label,
      source: context.source,
      timestamp,
      maxRows: options.maxRows,
      now,
    });
    sink.add(result);
    return result;
  } catch (error) {
    const failure: DebugResultError = {
      id,
      status: "error",
      ...context,
      message: errorMessage(error).slice(0, DEBUG_RESULT_LIMITS.MAX_ERROR_CHARS),
      ...postgresErrorFields(error),
      durationMs: Math.max(0, now() - startedAt),
      timestamp,
    };
    sink.addStatus(failure);
    return failure;
  }
}

function postgresErrorFields(
  error: unknown,
): Pick<DebugResultError, "code" | "detail" | "hint" | "position"> {
  if (!error || typeof error !== "object") return {};
  const source = error as Record<string, unknown>;
  return Object.fromEntries(
    (["code", "detail", "hint", "position"] as const).flatMap((key) => {
      const value = source[key];
      return typeof value === "string" && value.trim() ? [[key, value]] : [];
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
