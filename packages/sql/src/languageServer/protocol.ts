import type { PostgresDocumentSyntaxFacts } from "../analysis/documentFacts.js";
import type { SqlQueryAnalysis } from "../query/analysis.js";
import type {
  SqlComposition,
  SqlCompositionChoice,
  SqlCompositionRejection,
} from "../query/composition.js";
import type { SqlCaretRole, SqlRelationMention } from "../query/relations.js";
import type { SqlQueryShape } from "../query/shape.js";
import type { SqlAuthoringSnapshot, SqlAuthoringSnapshotToken } from "../snapshot.js";

/**
 * The requests the SQL authoring language server answers, and the shape of each answer. The
 * vocabulary those answers speak — the catalog snapshot and the settings — lives in `authoring`.
 */

export const SQL_AUTHORING_CONTEXT_REQUEST = "postgresql-workbench/documentContext";

export const SQL_AUTHORING_SYNTAX_REQUEST = "postgresql-workbench/syntax";

/** The command every host registers to reveal an indexed object in its own tree. */
export const REVEAL_SQL_REFERENCE_COMMAND = "postgresql-workbench.revealSqlReference";

/** What the reveal command receives: one indexed object, optionally narrowed to a column. */
export interface SqlAuthoringNavigationTarget {
  column?: string;
  database: string;
  oid: number;
  connectionId: string;
}

export const SQL_AUTHORING_COMPOSE_REQUEST = "postgresql-workbench/compose";

export const SQL_AUTHORING_SETTINGS_REQUEST = "postgresql-workbench/sqlAuthoringSettings";

export const SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED = "postgresql-workbench/semanticTokensChanged";

/**
 * A visible SQL document may be an editable fragment of a larger statement. The host owns the
 * surrounding statement because it owns the Data View query; the language server remains the one
 * place that combines both texts for analysis and projects every answer back to the visible
 * document.
 */
export interface SqlAuthoringDocumentProjection {
  /** Text immediately before the visible document in the statement analyzed by the server. */
  prefix: string;
  /** Text immediately after the visible document in the statement analyzed by the server. */
  suffix: string;
  /** Changes whenever prefix or suffix changes, even if the visible document does not. */
  revision: string;
}

export type SqlAuthoringDocumentContext =
  | {
      status: "available";
      snapshot: SqlAuthoringSnapshot;
      projection?: SqlAuthoringDocumentProjection;
    }
  | { status: "unassociated" | "unavailable" | "not-indexed"; message: string };

export interface SqlAuthoringSyntaxResult {
  hasError: boolean;
  truncated: boolean;
  /** Syntax analysis of the statement, when it is a plain SELECT the engine can rewrite. */
  analysis?: SqlQueryAnalysis;
  /** Relations the statement names, whatever its kind: FROM, JOIN, USING, UPDATE, INSERT INTO. */
  relations?: SqlRelationMention[];
  /** Complete host-neutral facts used by syntax-driven authoring decisions. */
  facts?: PostgresDocumentSyntaxFacts;
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

/**
 * One token with its kind named rather than numbered: what a consumer outside the protocol needs,
 * since a token number means nothing without the legend the server declared it against.
 */
export interface NamedSqlToken {
  /** Zero-based, as the language server counts lines. */
  line: number;
  character: number;
  length: number;
  type: string;
}

/**
 * The tokens of a document, resolved against a legend. A token whose kind the legend does not name
 * is dropped rather than guessed: a consumer that cannot say what it is cannot paint it.
 */
export function namedSemanticTokens(
  data: ArrayLike<number> | undefined,
  legend: readonly string[],
): NamedSqlToken[] {
  return decodeSemanticTokenData(data ?? []).flatMap((token) => {
    const type = legend[token.tokenType];
    return type === undefined
      ? []
      : [{ line: token.line, character: token.character, length: token.length, type }];
  });
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

/** A composition the server is asked for: what to compose, plus the document that asked. */
export interface SqlAuthoringComposeRequest extends SqlComposition {
  uri: string;
}

/** What the engine composed, plus the Index generation it was composed against. */
export type SqlAuthoringComposeResult =
  | { status: "edit"; text: string; title: string; snapshot?: SqlAuthoringSnapshotToken }
  | {
      status: "ambiguous";
      choices: SqlCompositionChoice[];
      title?: string;
      placeHolder?: string;
      snapshot?: SqlAuthoringSnapshotToken;
    }
  | { status: "rejected"; message: string; reason?: SqlAuthoringRejectionReason };

/** The engine's reasons, plus the ones only the server can know. */
export type SqlAuthoringRejectionReason =
  | SqlCompositionRejection
  | "unassociated"
  | "unavailable"
  | "not-indexed"
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
    context.snapshot.connectionId === token.connectionId &&
    context.snapshot.database === token.database &&
    context.snapshot.revision === token.revision &&
    context.snapshot.generation === token.generation
  );
}
