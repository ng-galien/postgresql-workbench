import type { DebugResult } from "../../src/debugger/launch/index.js";
import type { ServerConfig } from "./serverStore.js";

export const SQL_NOTEBOOK_TYPE = "postgresql-workbench-sql";
export const SQL_NOTEBOOK_EXTENSION = ".pgsql-notebook";
export const SQL_NOTEBOOK_RESULT_MIME = "application/vnd.postgresql-workbench.sql-result+json";
export const SQL_NOTEBOOK_RENDERER_ID = "postgresql-workbench.sql-result-renderer";
export const SQL_NOTEBOOK_VERSION = 1;

export interface SqlNotebookMetadata {
  serverId?: string;
  serverName?: string;
  database?: string;
}

export interface NotebookBindingSnapshot {
  serverId: string;
  serverName: string;
  database: string;
}

export type NotebookBinding =
  | { status: "bound"; snapshot: NotebookBindingSnapshot; server: ServerConfig }
  | { status: "unavailable"; snapshot: NotebookBindingSnapshot }
  | { status: "unbound" };

export interface SqlNotebookCellFile {
  kind: "code" | "markup";
  language: "plpgsql" | "markdown";
  source: string;
}

export interface SqlNotebookFile {
  version: 1;
  metadata: SqlNotebookMetadata;
  cells: SqlNotebookCellFile[];
}

export interface SqlNotebookResultPayload {
  version: 2;
  binding: NotebookBindingSnapshot;
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

export interface SqlNotebookRendererRequest {
  type: "sql-result/request";
  sessionId: string;
  action: SqlNotebookResultAction;
}

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

export function resolveNotebookBinding(
  metadata: SqlNotebookMetadata,
  servers: readonly ServerConfig[],
): NotebookBinding {
  const serverId = metadata.serverId?.trim();
  const database = metadata.database?.trim();
  if (!serverId || !database) return { status: "unbound" };

  const server = servers.find((candidate) => candidate.id === serverId);
  const snapshot: NotebookBindingSnapshot = {
    serverId,
    serverName: metadata.serverName?.trim() || server?.name || serverId,
    database,
  };
  if (!server || server.database !== database) {
    return { status: "unavailable", snapshot };
  }
  return { status: "bound", snapshot: bindingSnapshot(server), server };
}

export function bindingSnapshot(server: ServerConfig): NotebookBindingSnapshot {
  return {
    serverId: server.id,
    serverName: server.name,
    database: server.database,
  };
}

export function bindingFingerprint(binding: NotebookBindingSnapshot): string {
  return `${binding.serverId}\0${binding.database}`;
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
  const parsed = JSON.parse(raw) as Partial<SqlNotebookFile>;
  if (parsed.version !== SQL_NOTEBOOK_VERSION) {
    throw new Error(`Unsupported SQL notebook version: ${String(parsed.version)}`);
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
  binding: NotebookBindingSnapshot,
): SqlNotebookResultPayload {
  return {
    version: 2,
    binding,
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
  };
}

function normalizeCell(value: unknown): SqlNotebookCellFile[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  if (typeof source.source !== "string") return [];
  if (source.kind === "markup") {
    return [{ kind: "markup", language: "markdown", source: source.source }];
  }
  return [{ kind: "code", language: "plpgsql", source: source.source }];
}

function stringProperty(
  source: Record<string, unknown>,
  key: keyof SqlNotebookMetadata,
): Partial<SqlNotebookMetadata> {
  const value = source[key];
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}
