import type { DebugResult } from "../../src/debugger/launch/index.js";
import type { ServerConfig } from "./serverStore.js";

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
  serverId?: string;
  serverName?: string;
  database?: string;
  executionMode?: ScratchpadExecutionMode;
  statementTimeoutMs?: number;
}

/** Persistent Association between a Scratchpad and a saved Connexion. */
export interface ScratchpadAssociationSnapshot {
  serverId: string;
  serverName: string;
  database: string;
}

export type ScratchpadAssociation =
  | { status: "associated"; snapshot: ScratchpadAssociationSnapshot; connection: ServerConfig }
  | { status: "unavailable"; snapshot: ScratchpadAssociationSnapshot }
  | { status: "unassociated" };

export type ScratchpadCreationAssociation =
  | { kind: "unassociated" }
  | { kind: "automatic"; connection: ServerConfig }
  | { kind: "choose" };

// Compatibility names are intentionally confined to the VS Code/result adapters.
export type NotebookBindingSnapshot = ScratchpadAssociationSnapshot;

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

export interface SqlNotebookResultPayload {
  version: 2;
  binding: NotebookBindingSnapshot;
  /** SQL Statement that produced the result, when the producer knows it. */
  statement?: string;
  command: string;
  columns: DebugResult["columns"];
  rows: DebugResult["rows"];
  /** Exact total when known. Cursor-backed results leave it undefined until exhausted. */
  rowCount?: number;
  capturedRowCount: number;
  durationMs: number;
  truncated: boolean;
  truncationReasons: DebugResult["truncationReasons"];
  navigation?: SqlNotebookResultNavigation;
}

export interface SqlNotebookErrorPayload {
  version: 1;
  type: "error";
  title: string;
  message: string;
  category: "syntax" | "postgresql" | "connection" | "execution";
  statement?: number;
  code?: string;
  detail?: string;
  hint?: string;
  line?: number;
  column?: number;
  position?: string;
  action?: {
    type: "open-sql-analysis-settings" | "increase-scratchpad-timeout";
    label: string;
  };
}

export type SqlNotebookOutputPayload = SqlNotebookResultPayload | SqlNotebookErrorPayload;

export interface SqlNotebookResultNavigation {
  sessionId: string;
  mode: "paged" | "all";
  pageIndex: number;
  pageSize: number;
  pageStart: number;
  pageEnd: number;
  loadedRowCount: number;
  cacheStart: number;
  hasPrevious: boolean;
  hasNext: boolean;
  canLoadAll: boolean;
}

export type SqlNotebookResultAction = "attach" | "previous" | "next" | "load-all" | "cancel";

export interface SqlNotebookResultRequest {
  type: "sql-result/request";
  sessionId: string;
  action: SqlNotebookResultAction;
}

export type SqlNotebookSettingsRequest =
  | { type: "sql-error/open-analysis-settings" }
  | { type: "sql-error/increase-scratchpad-timeout" };

/** Asks the Extension Host to open the Statement of a result in a Data View. */
export interface SqlResultDataViewRequest {
  type: "sql-result/open-data-view";
  sql: string;
  binding: NotebookBindingSnapshot;
}

export type SqlNotebookRendererRequest =
  | SqlNotebookResultRequest
  | SqlNotebookSettingsRequest
  | SqlResultDataViewRequest;

export type SqlNotebookRendererResponse =
  | {
      type: "sql-result/update";
      sessionId: string;
      payload: SqlNotebookResultPayload;
    }
  | {
      type: "sql-result/progress";
      sessionId: string;
      loadedRowCount: number;
    }
  | {
      type: "sql-result/error";
      sessionId: string;
      message: string;
      closed: boolean;
    };

export function emptySqlNotebook(metadata: SqlNotebookMetadata = {}): SqlNotebookFile {
  return {
    version: SQL_NOTEBOOK_VERSION,
    metadata: normalizeMetadata(metadata),
    cells: [{ kind: "code", language: "plpgsql", source: "" }],
  };
}

export function resolveScratchpadAssociation(
  metadata: SqlNotebookMetadata,
  servers: readonly ServerConfig[],
): ScratchpadAssociation {
  const serverId = metadata.serverId?.trim();
  const database = metadata.database?.trim();
  if (!serverId || !database) return { status: "unassociated" };

  const server = servers.find((candidate) => candidate.id === serverId);
  const snapshot: ScratchpadAssociationSnapshot = {
    serverId,
    serverName: metadata.serverName?.trim() || server?.name || serverId,
    database,
  };
  if (!server || server.database !== database) {
    return { status: "unavailable", snapshot };
  }
  return { status: "associated", snapshot: associationSnapshot(server), connection: server };
}

export function associationSnapshot(server: ServerConfig): ScratchpadAssociationSnapshot {
  return {
    serverId: server.id,
    serverName: server.name,
    database: server.database,
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
  savedConnections: readonly ServerConfig[],
): ScratchpadCreationAssociation {
  if (savedConnections.length === 0) return { kind: "unassociated" };
  if (savedConnections.length === 1) {
    return { kind: "automatic", connection: savedConnections[0] };
  }
  return { kind: "choose" };
}

/** @deprecated Use associationSnapshot in product code. */
export const bindingSnapshot = associationSnapshot;

/** @deprecated Use resolveScratchpadAssociation in product code. */
export function resolveNotebookBinding(
  metadata: SqlNotebookMetadata,
  servers: readonly ServerConfig[],
):
  | { status: "bound"; snapshot: ScratchpadAssociationSnapshot; server: ServerConfig }
  | { status: "unavailable"; snapshot: ScratchpadAssociationSnapshot }
  | { status: "unbound" } {
  const association = resolveScratchpadAssociation(metadata, servers);
  if (association.status === "associated") {
    return { status: "bound", snapshot: association.snapshot, server: association.connection };
  }
  return association.status === "unassociated" ? { status: "unbound" } : association;
}

export function associationFingerprint(association: ScratchpadAssociationSnapshot): string {
  return `${association.serverId}\0${association.database}`;
}

/** @deprecated Use associationFingerprint in product code. */
export const bindingFingerprint = associationFingerprint;

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
  const parsed = JSON.parse(raw) as Partial<SqlNotebookFile>;
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
      metadata: normalizeMetadata(file.metadata),
      cells: file.cells.flatMap((cell) => normalizeCell(cell)),
    } satisfies SqlNotebookFile,
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

function normalizeMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    ...stringProperty(source, "serverId"),
    ...stringProperty(source, "serverName"),
    ...stringProperty(source, "database"),
    ...(source.executionMode === "manual" ? { executionMode: "manual" as const } : {}),
    ...(validStatementTimeoutMs(source.statementTimeoutMs) !== undefined
      ? { statementTimeoutMs: validStatementTimeoutMs(source.statementTimeoutMs) }
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

function stringProperty(
  source: Record<string, unknown>,
  key: keyof SqlNotebookMetadata,
): Partial<SqlNotebookMetadata> {
  const value = source[key];
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}
