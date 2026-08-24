import {
  type ConnectionConfig,
  getConnectionName,
} from "../../../packages/catalog/src/savedConnection.js";
import type { DebugResult } from "../../../packages/dap/src/debugger/launch/index.js";
import type {
  ScratchpadAssociationSnapshot,
  SqlNotebookResultPayload,
} from "../../../packages/rows/src/resultPayload.js";

export const SQL_NOTEBOOK_TYPE = "postgresql-workbench-sql";
export const SQL_NOTEBOOK_EXTENSION = ".pgsql-notebook";
export const SQL_NOTEBOOK_RESULT_MIME = "application/vnd.postgresql-workbench.sql-result+json";
export const SQL_NOTEBOOK_RENDERER_ID = "postgresql-workbench.sql-result-renderer";
export const SQL_NOTEBOOK_VERSION = 1;
export const DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS = 60_000;
export const MIN_SCRATCHPAD_STATEMENT_TIMEOUT_MS = 1_000;
export const MAX_SCRATCHPAD_STATEMENT_TIMEOUT_MS = 3_600_000;

/** Product-level execution mode persisted by each Scratchpad. */
export type ScratchpadExecutionMode = "auto" | "manual";
export type ScratchpadCellExecutionIntent = "run" | "debug";

export interface SqlNotebookCellMetadata {
  executionIntent?: ScratchpadCellExecutionIntent;
}

export interface SqlNotebookMetadata {
  connectionId?: string;
  connectionName?: string;
  database?: string;
  executionMode?: ScratchpadExecutionMode;
  statementTimeoutMs?: number;
}

/** Persistent Association between a Scratchpad and a saved Connection. */

export type ScratchpadAssociation =
  | { status: "associated"; snapshot: ScratchpadAssociationSnapshot; connection: ConnectionConfig }
  | { status: "unavailable"; snapshot: ScratchpadAssociationSnapshot }
  | { status: "unassociated" };

export type ScratchpadCreationAssociation =
  | { kind: "unassociated" }
  | { kind: "automatic"; connection: ConnectionConfig }
  | { kind: "choose" };

// Compatibility names are intentionally confined to the VS Code/result adapters.

export interface SqlNotebookCellFile {
  kind: "code" | "markup";
  language: "plpgsql" | "markdown";
  source: string;
  metadata?: SqlNotebookCellMetadata;
}

export interface SqlNotebookFile {
  version: 1;
  metadata: SqlNotebookMetadata;
  cells: SqlNotebookCellFile[];
}

/** Version-1 disk shape. Its `server*` keys are historical and must remain upgrade-readable. */
interface PersistedSqlNotebookMetadata {
  serverId?: string;
  serverName?: string;
  database?: string;
  executionMode?: ScratchpadExecutionMode;
  statementTimeoutMs?: number;
}

interface PersistedSqlNotebookFile {
  version: 1;
  metadata: PersistedSqlNotebookMetadata;
  cells: SqlNotebookCellFile[];
}

export function emptySqlNotebook(metadata: SqlNotebookMetadata = {}): SqlNotebookFile {
  return {
    version: SQL_NOTEBOOK_VERSION,
    metadata: normalizeMetadata(metadata),
    cells: [{ kind: "code", language: "plpgsql", source: "" }],
  };
}

export function resolveScratchpadAssociation(
  metadata: SqlNotebookMetadata,
  connections: readonly ConnectionConfig[],
): ScratchpadAssociation {
  const connectionId = metadata.connectionId?.trim();
  const database = metadata.database?.trim();
  if (!connectionId || !database) return { status: "unassociated" };

  const connection = connections.find((candidate) => candidate.id === connectionId);
  const snapshot: ScratchpadAssociationSnapshot = {
    connectionId,
    connectionName: connection
      ? getConnectionName(connection)
      : metadata.connectionName?.trim() || connectionId,
    database,
  };
  if (!connection || connection.database !== database) {
    return { status: "unavailable", snapshot };
  }
  return {
    status: "associated",
    snapshot: associationSnapshot(connection),
    connection: connection,
  };
}

export function associationSnapshot(connection: ConnectionConfig): ScratchpadAssociationSnapshot {
  return {
    connectionId: connection.id,
    connectionName: getConnectionName(connection),
    database: connection.database,
  };
}

export function scratchpadExecutionMode(metadata: SqlNotebookMetadata): ScratchpadExecutionMode {
  return metadata.executionMode === "manual" ? "manual" : "auto";
}

export function scratchpadCellExecutionIntent(metadata: unknown): ScratchpadCellExecutionIntent {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "run";
  return (metadata as Record<string, unknown>).executionIntent === "debug" ? "debug" : "run";
}

export function scratchpadStatementTimeoutMs(
  metadata: SqlNotebookMetadata,
  globalTimeoutMs = DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS,
): number {
  return (
    validStatementTimeoutMs(metadata.statementTimeoutMs) ??
    validStatementTimeoutMs(globalTimeoutMs) ??
    DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS
  );
}

export function validStatementTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SCRATCHPAD_STATEMENT_TIMEOUT_MS &&
    value <= MAX_SCRATCHPAD_STATEMENT_TIMEOUT_MS
    ? value
    : undefined;
}

export function scratchpadCreationAssociation(
  savedConnections: readonly ConnectionConfig[],
): ScratchpadCreationAssociation {
  if (savedConnections.length === 0) return { kind: "unassociated" };
  if (savedConnections.length === 1) {
    return { kind: "automatic", connection: savedConnections[0] };
  }
  return { kind: "choose" };
}

export function associationFingerprint(association: ScratchpadAssociationSnapshot): string {
  return `${association.connectionId}\0${association.database}`;
}

export function nextSqlNotebookName(existingNames: readonly string[]): string {
  const sequence = existingNames.reduce((highest, name) => {
    const match = /^Scratch (\d+)\.pgsql-notebook$/u.exec(name);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);
  return `Scratch ${String(sequence + 1).padStart(3, "0")}${SQL_NOTEBOOK_EXTENSION}`;
}

export function normalizeSqlNotebookName(value: string): string {
  const trimmed = value.trim();
  const displayName = trimmed.endsWith(SQL_NOTEBOOK_EXTENSION)
    ? trimmed.slice(0, -SQL_NOTEBOOK_EXTENSION.length)
    : trimmed;
  if (!displayName || displayName === "." || displayName === "..") {
    throw new Error("Choose a non-empty scratchpad name.");
  }
  const invalidCharacter = [...displayName].some(
    (character) => '/\\:*?"<>|'.includes(character) || character.charCodeAt(0) < 32,
  );
  if (invalidCharacter) {
    throw new Error("The scratchpad name contains a character that is not valid in a file name.");
  }
  if (displayName.endsWith(".")) {
    throw new Error("The scratchpad name cannot end with a period.");
  }
  const windowsBaseName = displayName.split(".")[0]?.toUpperCase();
  if (windowsBaseName && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsBaseName)) {
    throw new Error("Choose a scratchpad name that is portable across operating systems.");
  }
  return `${displayName}${SQL_NOTEBOOK_EXTENSION}`;
}

export function parseSqlNotebookFile(raw: string): SqlNotebookFile {
  if (!raw.trim()) return emptySqlNotebook();
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    metadata?: unknown;
    cells?: unknown;
  };
  if (parsed.version !== SQL_NOTEBOOK_VERSION) {
    throw new Error(`Unsupported Scratchpad file version: ${String(parsed.version)}`);
  }
  const cells = Array.isArray(parsed.cells)
    ? parsed.cells.flatMap((cell) => normalizeCell(cell))
    : [];
  return {
    version: SQL_NOTEBOOK_VERSION,
    metadata: normalizeMetadata(parsed.metadata),
    cells: cells.length > 0 ? cells : emptySqlNotebook().cells,
  };
}

export function serializeSqlNotebookFile(file: SqlNotebookFile): string {
  return `${JSON.stringify(
    {
      version: SQL_NOTEBOOK_VERSION,
      metadata: persistedMetadata(file.metadata),
      cells: file.cells.flatMap((cell) => normalizeCell(cell)),
    } satisfies PersistedSqlNotebookFile,
    null,
    2,
  )}\n`;
}

export function sqlNotebookResultPayload(
  result: DebugResult,
  binding: ScratchpadAssociationSnapshot,
  statement?: string,
): SqlNotebookResultPayload {
  return {
    version: 2,
    binding,
    ...(statement !== undefined ? { statement } : {}),
    command: result.command,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    capturedRowCount: result.capturedRowCount,
    durationMs: result.durationMs,
    truncated: result.truncated,
    truncationReasons: result.truncationReasons,
  };
}

/**
 * A notebook's metadata, read from whatever was stored. The file format owns this: the serializer
 * reads it off a document, the controller and the status bar read it off the one VS Code holds,
 * and all three must agree on what an absent or malformed field means.
 */
export function normalizeMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const connectionId = stringValue(source.connectionId) ?? stringValue(source.serverId);
  const connectionName = stringValue(source.connectionName) ?? stringValue(source.serverName);
  const database = stringValue(source.database);
  return {
    ...(connectionId ? { connectionId } : {}),
    ...(connectionName ? { connectionName } : {}),
    ...(database ? { database } : {}),
    ...(source.executionMode === "manual" ? { executionMode: "manual" as const } : {}),
    ...(validStatementTimeoutMs(source.statementTimeoutMs) !== undefined
      ? { statementTimeoutMs: validStatementTimeoutMs(source.statementTimeoutMs) }
      : {}),
  };
}

function persistedMetadata(value: SqlNotebookMetadata): PersistedSqlNotebookMetadata {
  const metadata = normalizeMetadata(value);
  return {
    ...(metadata.connectionId ? { serverId: metadata.connectionId } : {}),
    ...(metadata.connectionName ? { serverName: metadata.connectionName } : {}),
    ...(metadata.database ? { database: metadata.database } : {}),
    ...(metadata.executionMode === "manual" ? { executionMode: "manual" as const } : {}),
    ...(metadata.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: metadata.statementTimeoutMs }
      : {}),
  };
}

function normalizeCell(value: unknown): SqlNotebookCellFile[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  if (typeof source.source !== "string") return [];
  if (source.kind === "markup") {
    return [{ kind: "markup", language: "markdown", source: source.source }];
  }
  const executionIntent = scratchpadCellExecutionIntent(source.metadata);
  return [
    {
      kind: "code",
      language: "plpgsql",
      source: source.source,
      ...(executionIntent === "debug" ? { metadata: { executionIntent } } : {}),
    },
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
