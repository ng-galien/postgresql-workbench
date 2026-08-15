export const SQL_AUTHORING_CONTEXT_REQUEST = "postgresql-workbench/documentContext";
export const SQL_AUTHORING_SYNTAX_REQUEST = "postgresql-workbench/syntax";
export const SQL_AUTHORING_COMPOSE_REQUEST = "postgresql-workbench/compose";
export const SQL_AUTHORING_OBJECT_MIME = "application/vnd.postgresql-workbench.sql-object";

export interface SqlAuthoringDatabaseIdentity {
  serverId: string;
  database: string;
}

export interface SqlAuthoringColumn {
  name: string;
  type: string;
}

export type SqlAuthoringObjectKind = "table" | "view" | "function" | "procedure";

export interface SqlAuthoringObject {
  serverId: string;
  database: string;
  schema: string;
  oid: number;
  name: string;
  kind: SqlAuthoringObjectKind;
  signature: string;
  parameters: Array<{ name: string; type: string }>;
  columns: SqlAuthoringColumn[];
}

export interface SqlAuthoringForeignKey {
  sourceTableOid: number;
  targetTableOid: number;
  sourceColumns: string[];
  sourceColumnsNullable: boolean[];
  targetColumns: string[];
}

export interface SqlAuthoringSnapshot extends SqlAuthoringDatabaseIdentity {
  status: "available" | "stale";
  revision: string;
  generation: number | null;
  objects: SqlAuthoringObject[];
  foreignKeys: SqlAuthoringForeignKey[];
}

export type SqlAuthoringDocumentContext =
  | { status: "available"; snapshot: SqlAuthoringSnapshot }
  | { status: "unassociated" | "unavailable" | "not-indexed"; message: string };

export interface SqlAuthoringSyntaxResult {
  hasError: boolean;
}

export type SqlAuthoringDragPayload =
  | ({
      kind: "table" | "view";
      oid: number;
      schema: string;
      name: string;
    } & SqlAuthoringDatabaseIdentity)
  | ({
      kind: "column";
      tableOid: number;
      tableSchema: string;
      tableName: string;
      name: string;
    } & SqlAuthoringDatabaseIdentity);

export function serializeSqlAuthoringDrag(payload: SqlAuthoringDragPayload): string {
  return JSON.stringify(payload);
}

export function parseSqlAuthoringDrag(value: string): SqlAuthoringDragPayload | undefined {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof payload.serverId !== "string" ||
      typeof payload.database !== "string" ||
      typeof payload.name !== "string"
    ) {
      return undefined;
    }
    if (payload.kind === "table" || payload.kind === "view") {
      return typeof payload.oid === "number" && typeof payload.schema === "string"
        ? (payload as unknown as SqlAuthoringDragPayload)
        : undefined;
    }
    if (payload.kind === "column") {
      return typeof payload.tableOid === "number" &&
        typeof payload.tableSchema === "string" &&
        typeof payload.tableName === "string"
        ? (payload as unknown as SqlAuthoringDragPayload)
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface SqlAuthoringComposeRequest {
  uri: string;
  text: string;
  offset: number;
  payload: SqlAuthoringDragPayload;
  relationChoice?: number;
}

export type SqlAuthoringComposeResult =
  | { status: "edit"; text: string; title: string }
  | { status: "ambiguous"; choices: Array<{ index: number; label: string; description: string }> }
  | { status: "rejected"; message: string };
