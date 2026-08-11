export const DEBUG_RESULT_EVENT = "plpgsql/result";
export const DEBUG_RESULT_STATUS_EVENT = "plpgsql/resultStatus";

export const DEBUG_RESULT_LIMITS = {
  DEFAULT_ROWS: 200,
  MIN_ROWS: 20,
  MAX_ROWS: 1_000,
  MAX_CELL_BYTES: 64 * 1024,
  MAX_PAYLOAD_BYTES: 1024 * 1024,
  MAX_LABEL_CHARS: 256,
  MAX_QUERY_CHARS: 16 * 1024,
  MAX_SOURCE_NAME_CHARS: 512,
  MAX_SOURCE_URI_CHARS: 4 * 1024,
  MAX_ERROR_CHARS: 8 * 1024,
} as const;

export type DebugResultCellKind = "null" | "text" | "number" | "boolean" | "json" | "binary";
export type DebugResultTruncationReason = "rows" | "payload" | "cell";

export interface DebugResultCell {
  kind: DebugResultCellKind;
  value: string | null;
  truncated?: true;
}

export interface DebugResultColumn {
  name: string;
  dataTypeId: number;
  typeName?: string;
}

export interface DebugResultSource {
  name: string;
  uri?: string;
  line?: number;
}

export interface DebugResultContext {
  label: string;
  query: string;
  source?: DebugResultSource;
}

export interface DebugResult {
  id: string;
  label?: string;
  query?: string;
  source?: DebugResultSource;
  command: string;
  columns: DebugResultColumn[];
  rows: DebugResultCell[][];
  rowCount: number;
  capturedRowCount: number;
  truncated: boolean;
  truncationReasons: DebugResultTruncationReason[];
  durationMs: number;
  timestamp: string;
  payloadBytes: number;
}

export interface DebugResultPending extends DebugResultContext {
  id: string;
  status: "pending";
  timestamp: string;
}

export interface DebugResultError extends DebugResultContext {
  id: string;
  status: "error";
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  durationMs: number;
  timestamp: string;
}

export type DebugResultStatus = DebugResultPending | DebugResultError;
export type DebugResultEntry = DebugResult | DebugResultStatus;

export function debugResultEntryStatus(entry: DebugResultEntry): "pending" | "success" | "error" {
  return "status" in entry ? entry.status : "success";
}

export function createDebugResultContext(
  label: string,
  query: string,
  source?: DebugResultSource,
): DebugResultContext {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const normalizedSource = source
    ? {
        name: source.name.slice(0, DEBUG_RESULT_LIMITS.MAX_SOURCE_NAME_CHARS),
        ...(source.uri
          ? { uri: source.uri.slice(0, DEBUG_RESULT_LIMITS.MAX_SOURCE_URI_CHARS) }
          : {}),
        ...(source.line !== undefined ? { line: Math.max(1, Math.trunc(source.line)) } : {}),
      }
    : undefined;
  return {
    label:
      label.trim().slice(0, DEBUG_RESULT_LIMITS.MAX_LABEL_CHARS) ||
      normalizedQuery.slice(0, DEBUG_RESULT_LIMITS.MAX_LABEL_CHARS) ||
      "SQL result",
    query: normalizedQuery.slice(0, DEBUG_RESULT_LIMITS.MAX_QUERY_CHARS),
    ...(normalizedSource ? { source: normalizedSource } : {}),
  };
}

export function clampDebugResultRows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEBUG_RESULT_LIMITS.DEFAULT_ROWS;
  }
  return Math.min(
    DEBUG_RESULT_LIMITS.MAX_ROWS,
    Math.max(DEBUG_RESULT_LIMITS.MIN_ROWS, Math.trunc(value)),
  );
}
