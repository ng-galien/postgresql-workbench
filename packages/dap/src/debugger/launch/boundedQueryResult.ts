import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import { type Client, type FieldDef, Query, type QueryArrayConfig, type QueryResultBase } from "pg";
import {
  createDebugResultContext,
  DEBUG_RESULT_LIMITS,
  type DebugResult,
  type DebugResultCell,
  type DebugResultCellKind,
  type DebugResultColumn,
  type DebugResultSource,
  type DebugResultTruncationReason,
} from "./debugResult.js";

export interface BoundedQueryResultOptions {
  id: string;
  label?: string;
  source?: DebugResultSource;
  timestamp?: string;
  maxRows: number;
  maxCellBytes?: number;
  maxPayloadBytes?: number;
  now?: () => number;
}

const JSON_TYPE_OIDS = new Set([114, 3802]);
const BINARY_TYPE_OIDS = new Set([17]);
const BOOLEAN_TYPE_OIDS = new Set([16]);
const NUMBER_TYPE_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
const POSTGRES_TYPE_NAMES = new Map<number, string>([
  [16, "boolean"],
  [17, "bytea"],
  [18, "char"],
  [19, "name"],
  [20, "bigint"],
  [21, "smallint"],
  [23, "integer"],
  [25, "text"],
  [26, "oid"],
  [114, "json"],
  [700, "real"],
  [701, "double precision"],
  [790, "money"],
  [1042, "character"],
  [1043, "character varying"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamp with time zone"],
  [1186, "interval"],
  [1266, "time with time zone"],
  [1700, "numeric"],
  [2950, "uuid"],
  [3802, "jsonb"],
]);
const UTF8_ENCODER = new TextEncoder();

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const probe = new Uint8Array(maxBytes);
  const first = UTF8_ENCODER.encodeInto(value, probe);
  if (first.read === value.length) return { value, truncated: false };
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes < suffixBytes) return { value: "", truncated: true };
  const content = new Uint8Array(maxBytes - suffixBytes);
  const bounded = UTF8_ENCODER.encodeInto(value, content);
  return { value: `${value.slice(0, bounded.read)}${suffix}`, truncated: true };
}

function formatBuffer(value: Buffer, maxBytes: number): DebugResultCell {
  const fullHexBytes = 2 + value.length * 2;
  if (fullHexBytes <= maxBytes) {
    return { kind: "binary", value: `\\x${value.toString("hex")}` };
  }

  const suffixBytes = Buffer.byteLength("…", "utf8");
  const retainedBytes = Math.max(0, Math.floor((maxBytes - 2 - suffixBytes) / 2));
  const bounded = truncateUtf8(`\\x${value.subarray(0, retainedBytes).toString("hex")}…`, maxBytes);
  return { kind: "binary", value: bounded.value, truncated: true };
}

function stringifyObject(value: object): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return nested.toString();
      if (nested && typeof nested === "object") {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch {
    return String(value);
  }
}

function cellKind(value: unknown, dataTypeId: number): DebugResultCellKind {
  if (value === null || value === undefined) return "null";
  if (BINARY_TYPE_OIDS.has(dataTypeId) || Buffer.isBuffer(value)) return "binary";
  if (JSON_TYPE_OIDS.has(dataTypeId) || typeof value === "object") return "json";
  if (BOOLEAN_TYPE_OIDS.has(dataTypeId) || typeof value === "boolean") return "boolean";
  if (NUMBER_TYPE_OIDS.has(dataTypeId) || typeof value === "number" || typeof value === "bigint") {
    return "number";
  }
  return "text";
}

function formatCell(value: unknown, field: FieldDef, maxBytes: number): DebugResultCell {
  const kind = cellKind(value, field.dataTypeID);
  if (kind === "null") return { kind, value: null };
  if (Buffer.isBuffer(value)) return formatBuffer(value, maxBytes);

  let display: string;
  if (value instanceof Date) {
    display = value.toISOString();
  } else if (value !== null && typeof value === "object") {
    display = stringifyObject(value);
  } else {
    display = String(value);
  }

  const bounded = truncateUtf8(display, maxBytes);
  return {
    kind,
    value: bounded.value,
    ...(bounded.truncated ? { truncated: true as const } : {}),
  };
}

/**
 * The types a result's columns were declared with. The table above holds the ones every PostgreSQL
 * has at the same number; everything else — arrays, ranges, network addresses, and every enum a
 * schema declares, whose number differs from one database to the next — can only be named by the
 * database itself, and reaches this through `resolved`. A column nobody could name says its number,
 * which is at least something a reader can look up.
 */
export function queryResultColumns(
  fields: readonly FieldDef[],
  resolved?: ReadonlyMap<number, string>,
): DebugResultColumn[] {
  return fields.map((field) => ({
    name: field.name,
    dataTypeId: field.dataTypeID,
    typeName:
      resolved?.get(field.dataTypeID) ??
      POSTGRES_TYPE_NAMES.get(field.dataTypeID) ??
      `oid ${field.dataTypeID}`,
  }));
}

/** The type numbers of a result that the built-in table cannot name. */
export function unnamedTypeIds(fields: readonly FieldDef[]): number[] {
  return [
    ...new Set(
      fields.flatMap((field) =>
        POSTGRES_TYPE_NAMES.has(field.dataTypeID) ? [] : [field.dataTypeID],
      ),
    ),
  ];
}

export function formatQueryResultRow(
  row: readonly unknown[],
  fields: readonly FieldDef[],
  maxCellBytes = DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
): DebugResultCell[] {
  const boundedCellBytes = Math.min(DEBUG_RESULT_LIMITS.MAX_CELL_BYTES, Math.max(1, maxCellBytes));
  return fields.map((field, index) => formatCell(row[index], field, boundedCellBytes));
}

function resultPayloadBytes(result: Omit<DebugResult, "payloadBytes">): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

/**
 * Run the target query without retaining every PostgreSQL row in node-postgres.
 *
 * Attaching the row listener before Client.query() makes pg stream rows through
 * the listener instead of populating QueryResult.rows. The query is still fully
 * consumed, so result limiting never changes the debuggee's execution semantics.
 */
export function runBoundedQuery(
  client: Client,
  text: string,
  values: unknown[],
  options: BoundedQueryResultOptions,
): Promise<DebugResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxCellBytes = Math.min(
    DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
    Math.max(1, options.maxCellBytes ?? DEBUG_RESULT_LIMITS.MAX_CELL_BYTES),
  );
  const maxPayloadBytes = Math.min(
    DEBUG_RESULT_LIMITS.MAX_PAYLOAD_BYTES,
    Math.max(1, options.maxPayloadBytes ?? DEBUG_RESULT_LIMITS.MAX_PAYLOAD_BYTES),
  );
  const rows: DebugResultCell[][] = [];
  const reasons = new Set<DebugResultTruncationReason>();
  const context = createDebugResultContext(options.label ?? text, text, options.source);
  const timestamp = options.timestamp ?? new Date().toISOString();
  let seenRows = 0;
  let fields: FieldDef[] = [];

  const queryConfig: QueryArrayConfig<unknown[]> = {
    text,
    values,
    rowMode: "array",
  };
  const query = new Query(queryConfig) as unknown as Query<Record<string, unknown>>;

  return new Promise((resolve, reject) => {
    query.on("row", (rawRow: unknown, result) => {
      seenRows += 1;
      fields = result?.fields ?? fields;
      if (rows.length >= options.maxRows) {
        reasons.add("rows");
        return;
      }

      const row = rawRow as unknown[];
      const formatted = formatQueryResultRow(row, fields, maxCellBytes);
      if (formatted.some((cell) => cell.truncated)) reasons.add("cell");
      rows.push(formatted);
    });
    query.on("error", reject);
    query.on("end", (rawResult) => {
      const result = (Array.isArray(rawResult)
        ? rawResult.at(-1)
        : rawResult) as unknown as QueryResultBase;
      fields = result?.fields ?? fields;

      const base: Omit<DebugResult, "payloadBytes"> = {
        id: options.id,
        ...context,
        command: result?.command ?? "SQL",
        columns: queryResultColumns(fields),
        rows,
        rowCount: result?.rowCount ?? seenRows,
        capturedRowCount: rows.length,
        truncated: false,
        truncationReasons: [] as DebugResultTruncationReason[],
        durationMs: Math.max(0, now() - startedAt),
        timestamp,
      };

      if (base.capturedRowCount < seenRows) reasons.add("rows");
      base.truncated = reasons.size > 0;
      base.truncationReasons = [...reasons];
      let payloadBytes = resultPayloadBytes(base);
      while (payloadBytes > maxPayloadBytes && base.rows.length > 0) {
        base.rows.pop();
        base.capturedRowCount = base.rows.length;
        reasons.add("payload");
        base.truncated = true;
        base.truncationReasons = [...reasons];
        payloadBytes = resultPayloadBytes(base);
      }
      if (payloadBytes > maxPayloadBytes) {
        reasons.add("payload");
        base.columns = base.columns.map(({ name, dataTypeId }) => ({ name, dataTypeId }));
        delete base.source;
        base.label = truncateUtf8(base.label ?? "", 128).value;
        base.query = truncateUtf8(base.query ?? "", 256).value;
        base.truncated = true;
        base.truncationReasons = [...reasons];
        payloadBytes = resultPayloadBytes(base);
      }

      resolve({ ...base, payloadBytes });
    });
    client.query(query);
  });
}
