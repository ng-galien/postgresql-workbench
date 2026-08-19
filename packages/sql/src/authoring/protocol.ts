import type { SqlQueryAnalysis } from "./query/analysis.js";
import type { SqlCaretRole, SqlRelationMention } from "./query/relations.js";
import type { SqlQueryShape } from "./queryShape.js";

export const SQL_AUTHORING_CONTEXT_REQUEST = "postgresql-workbench/documentContext";
export const SQL_AUTHORING_SYNTAX_REQUEST = "postgresql-workbench/syntax";
export const SQL_AUTHORING_COMPOSE_REQUEST = "postgresql-workbench/compose";
export const SQL_AUTHORING_SETTINGS_REQUEST = "postgresql-workbench/sqlAuthoringSettings";
export const SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED = "postgresql-workbench/semanticTokensChanged";
export const SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST = "postgresql-workbench/plpgsqlSemanticTokens";
export const SQL_AUTHORING_OBJECT_MIME = "application/vnd.postgresql-workbench.sql-object";

export type SqlAuthoringAliasStyle = "fullName" | "initial";

export interface SqlAuthoringSettings {
  aliasStyle: SqlAuthoringAliasStyle;
  syntaxMaxDepth: number;
  syntaxMaxNodes: number;
  tabSize: number;
}

export const DEFAULT_SQL_AUTHORING_SETTINGS: SqlAuthoringSettings = {
  aliasStyle: "fullName",
  syntaxMaxDepth: 1_024,
  syntaxMaxNodes: 100_000,
  tabSize: 2,
};

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
  plpgsql?: boolean;
  returnType?: string;
  parameters: Array<{ name: string; type: string }>;
  columns: SqlAuthoringColumn[];
}

export interface SqlAuthoringTrigger {
  oid: number;
  schema: string;
  name: string;
  relationSchema: string;
  relationName: string;
  routineSchema: string;
  routineName: string;
  definition: string;
}

export interface SqlAuthoringForeignKey {
  sourceTableOid: number;
  targetTableOid: number;
  sourceColumns: string[];
  sourceColumnsNullable: boolean[];
  targetColumns: string[];
  validated: boolean;
}

export interface SqlAuthoringSnapshot extends SqlAuthoringDatabaseIdentity {
  status: "available" | "stale";
  revision: string;
  generation: number | null;
  objects: SqlAuthoringObject[];
  foreignKeys: SqlAuthoringForeignKey[];
  triggers?: SqlAuthoringTrigger[];
}

export interface SqlAuthoringSnapshotToken extends SqlAuthoringDatabaseIdentity {
  revision: string;
  generation: number | null;
}

export type SqlAuthoringDocumentContext =
  | { status: "available"; snapshot: SqlAuthoringSnapshot }
  | { status: "unassociated" | "unavailable" | "not-indexed"; message: string };

export interface SqlAuthoringSyntaxResult {
  hasError: boolean;
  truncated: boolean;
  /** Syntax analysis of the statement, when it is a plain SELECT the engine can rewrite. */
  analysis?: SqlQueryAnalysis;
  /** Relations the statement names, whatever its kind: FROM, JOIN, USING, UPDATE, INSERT INTO. */
  relations?: SqlRelationMention[];
  /** What the caret names, when one was given: a relation or an expression. */
  caretRole?: SqlCaretRole;
  /** Shape of the statement: nested query, and whether composition can rewrite it. */
  shape?: SqlQueryShape;
  /** 1-based line of the first syntax problem when `hasError` is set. */
  errorLine?: number;
  /** The source is a bare PL/pgSQL body rather than SQL. */
  plpgsqlBody?: boolean;
}

/** One absolute semantic token encoded against the SQL authoring legend. */
export interface SqlAuthoringSemanticToken {
  line: number;
  character: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

export interface SqlAuthoringPlpgsqlTokensResult {
  tokens: SqlAuthoringSemanticToken[];
}

/** Decodes LSP delta-encoded semantic token data into absolute tokens. */
export function decodeSemanticTokenData(data: ArrayLike<number>): SqlAuthoringSemanticToken[] {
  const tokens: SqlAuthoringSemanticToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index];
    line += deltaLine;
    character = deltaLine === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({
      line,
      character,
      length: data[index + 2],
      tokenType: data[index + 3],
      tokenModifiers: data[index + 4],
    });
  }
  return tokens;
}

export type SqlAuthoringDragPayload =
  | ({
      kind: "table" | "view" | "function" | "procedure" | "trigger";
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
    if (
      payload.kind === "table" ||
      payload.kind === "view" ||
      payload.kind === "function" ||
      payload.kind === "procedure" ||
      payload.kind === "trigger"
    ) {
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
  | { status: "edit"; text: string; title: string; snapshot?: SqlAuthoringSnapshotToken }
  | {
      status: "ambiguous";
      choices: Array<{ index: number; label: string; description: string }>;
      title?: string;
      placeHolder?: string;
      snapshot?: SqlAuthoringSnapshotToken;
    }
  | { status: "rejected"; message: string; reason?: SqlAuthoringRejectionReason };

export type SqlAuthoringRejectionReason =
  | "unassociated"
  | "unavailable"
  | "not-indexed"
  | "stale"
  | "syntax-budget"
  | "syntax-error"
  | "snapshot-changed";

export function sqlAuthoringSnapshotToken(
  snapshot: SqlAuthoringSnapshot,
): SqlAuthoringSnapshotToken {
  return {
    serverId: snapshot.serverId,
    database: snapshot.database,
    revision: snapshot.revision,
    generation: snapshot.generation,
  };
}

export function sqlAuthoringContextMatchesToken(
  context: SqlAuthoringDocumentContext,
  token: SqlAuthoringSnapshotToken | undefined,
): boolean {
  return (
    token !== undefined &&
    context.status === "available" &&
    context.snapshot.status === "available" &&
    context.snapshot.serverId === token.serverId &&
    context.snapshot.database === token.database &&
    context.snapshot.revision === token.revision &&
    context.snapshot.generation === token.generation
  );
}
