import type { SqlQueryAnalysis } from "../authoring/query/analysis.js";
import type { SqlCaretRole, SqlRelationMention } from "../authoring/query/relations.js";
import type { SqlQueryShape } from "../authoring/queryShape.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSnapshot,
  SqlAuthoringSnapshotToken,
} from "../authoring/snapshot.js";

/**
 * The requests the SQL authoring language server answers, and the shape of each answer. The
 * vocabulary those answers speak — the catalog snapshot and the settings — lives in `authoring`.
 */

export const SQL_AUTHORING_CONTEXT_REQUEST = "postgresql-workbench/documentContext";

export const SQL_AUTHORING_SYNTAX_REQUEST = "postgresql-workbench/syntax";

export const SQL_AUTHORING_COMPOSE_REQUEST = "postgresql-workbench/compose";

export const SQL_AUTHORING_SETTINGS_REQUEST = "postgresql-workbench/sqlAuthoringSettings";

export const SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED = "postgresql-workbench/semanticTokensChanged";

export const SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST = "postgresql-workbench/plpgsqlSemanticTokens";

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
