import type { SqlQueryAnalysis } from "../query/analysis.js";
import { composePostgresSql } from "../query/composition.js";
import type { SqlQueryShape } from "../query/shape.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringSettings,
  sqlAuthoringSnapshotToken,
} from "../snapshot.js";
import { sqlStatementAtOffset } from "../text/sqlLexing.js";
import {
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
} from "./protocol.js";

export const SQL_AUTHORING_SYNTAX_BUDGET_MESSAGE =
  "The SQL syntax tree reached the configured analysis budget. Increase postgresql-workbench.sqlAuthoring.syntaxMaxDepth or syntaxMaxNodes before composing.";

export async function composeSqlAuthoringRequest(
  request: SqlAuthoringComposeRequest,
  documentContext: () => Promise<SqlAuthoringDocumentContext>,
  validateSyntax: (source: string) => Promise<SqlAuthoringSyntaxResult>,
  settings: SqlAuthoringSettings = DEFAULT_SQL_AUTHORING_SETTINGS,
): Promise<SqlAuthoringComposeResult> {
  const initial = await documentContext();
  if (initial.status !== "available") {
    return { status: "rejected", message: initial.message, reason: initial.status };
  }
  if (initial.snapshot.status !== "available") {
    return {
      status: "rejected",
      message: "The Workbench Index is stale. Reindex before composing SQL.",
      reason: "stale",
    };
  }
  const initialToken = sqlAuthoringSnapshotToken(initial.snapshot);
  const statement = sqlStatementAtOffset(request.text, request.offset);
  let analysis: SqlQueryAnalysis | undefined;
  let shape: SqlQueryShape | undefined;
  if (statement.text.trim().length > 0) {
    const syntax = await validateSyntax(statement.text);
    analysis = syntax.analysis;
    shape = syntax.shape;
    if (syntax.truncated) {
      return {
        status: "rejected",
        message: SQL_AUTHORING_SYNTAX_BUDGET_MESSAGE,
        reason: "syntax-budget",
      };
    }
    if (syntax.hasError) {
      return {
        status: "rejected",
        message: "The current SQL contains a syntax error. Fix it before composing the query.",
        reason: "syntax-error",
      };
    }
  }
  const current = await documentContext();
  if (current.status !== "available" || !sqlAuthoringContextMatchesToken(current, initialToken)) {
    return {
      status: "rejected",
      message:
        "The Workbench Index changed while composing SQL. Retry the drop on the fresh snapshot.",
      reason: "snapshot-changed",
    };
  }
  const result = composePostgresSql(request, current.snapshot, settings, analysis, shape);
  return result.status === "rejected" ? result : { ...result, snapshot: initialToken };
}

export function sqlAuthoringEditStillApplies(
  result: SqlAuthoringComposeResult,
  context: SqlAuthoringDocumentContext,
  requestedText: string,
  currentText: string,
): boolean {
  return (
    result.status === "edit" &&
    requestedText === currentText &&
    sqlAuthoringContextMatchesToken(context, result.snapshot)
  );
}
