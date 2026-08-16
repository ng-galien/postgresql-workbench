import { composePostgresSql } from "./composition.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSettings,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
  sqlAuthoringSnapshotToken,
} from "./protocol.js";
import { sqlStatementAtOffset } from "./sqlLexing.js";

export async function composeSqlAuthoringRequest(
  request: SqlAuthoringComposeRequest,
  documentContext: () => Promise<SqlAuthoringDocumentContext>,
  validateSyntax: (source: string) => Promise<SqlAuthoringSyntaxResult>,
  settings: SqlAuthoringSettings = DEFAULT_SQL_AUTHORING_SETTINGS,
): Promise<SqlAuthoringComposeResult> {
  const initial = await documentContext();
  if (initial.status !== "available") {
    return { status: "rejected", message: initial.message };
  }
  if (initial.snapshot.status !== "available") {
    return {
      status: "rejected",
      message: "The Workbench Index is stale. Reindex before composing SQL.",
    };
  }
  const initialToken = sqlAuthoringSnapshotToken(initial.snapshot);
  const statement = sqlStatementAtOffset(request.text, request.offset);
  if (statement.text.trim().length > 0) {
    const syntax = await validateSyntax(statement.text);
    if (syntax.truncated) {
      return {
        status: "rejected",
        message:
          "The SQL syntax tree reached the configured analysis budget. Increase the SQL analysis settings before composing the query.",
      };
    }
    if (syntax.hasError) {
      return {
        status: "rejected",
        message: "The current SQL contains a syntax error. Fix it before composing the query.",
      };
    }
  }
  const current = await documentContext();
  if (current.status !== "available" || !sqlAuthoringContextMatchesToken(current, initialToken)) {
    return {
      status: "rejected",
      message:
        "The Workbench Index changed while composing SQL. Retry the drop on the fresh snapshot.",
    };
  }
  const result = composePostgresSql(request, current.snapshot, settings);
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
