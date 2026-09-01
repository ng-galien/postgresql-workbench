import * as vscode from "vscode";
import { DedicatedNotebookConnectionError } from "../../../packages/rows/src/notebookClient.js";
import {
  notebookErrorPayload,
  type SqlFailure,
  type SqlNotebookErrorPayload,
  type SqlStatementResultPayload,
  sqlFailurePayload,
} from "../../../packages/rows/src/resultPayload.js";
import { SQL_NOTEBOOK_RESULT_MIME } from "../../../packages/scratchpad/src/notebookFile.js";
import type { SqlExecutionPlan } from "../../../packages/sql/src/analysis/sqlStatements.js";
import { statementResultSummary } from "../../../packages/views/src/results/statementResult.js";
import { errorMessage } from "../errorMessage.js";

/**
 * What a cell shows when its SQL did not run: the payload the renderer draws, and the one line of
 * text VS Code falls back to. A failure has three shapes — the statement would not parse, PostgreSQL
 * refused it, or the reader cancelled — and each says what it is in the reader's own words.
 */

export function errorOutput(payload: SqlNotebookErrorPayload): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(payload, SQL_NOTEBOOK_RESULT_MIME),
    vscode.NotebookCellOutputItem.text(errorSummary(payload)),
  ]);
}

export function resultOutput(payload: SqlStatementResultPayload): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(payload, SQL_NOTEBOOK_RESULT_MIME),
    vscode.NotebookCellOutputItem.text(resultSummary(payload)),
  ]);
}

function resultSummary(result: SqlStatementResultPayload): string {
  const command =
    result.kind === "rowset"
      ? result.command
      : result.entries.length === 1
        ? result.entries[0]?.operation
        : "COMMANDS";
  const truncation = result.kind === "rowset" && result.truncated ? " · preview truncated" : "";
  return `${command ?? "COMMAND"} · ${statementResultSummary(result)} · ${result.durationMs} ms${truncation}`;
}

function errorSummary(error: SqlNotebookErrorPayload): string {
  const statement = error.statement ? ` · statement ${error.statement}` : "";
  const code = error.code ? ` · ${error.code}` : "";
  return `${error.title}${statement}${code}: ${error.message}`;
}

export function planErrorPayload(
  plan: Exclude<SqlExecutionPlan, { status: "ready" } | { status: "empty" }>,
): SqlNotebookErrorPayload {
  if (plan.status === "syntax-error") {
    const location =
      plan.line !== undefined
        ? ` at line ${plan.line}${plan.column !== undefined ? `, column ${plan.column}` : ""}`
        : "";
    return {
      version: 1,
      type: "error",
      category: "syntax",
      title: "SQL syntax error",
      message: `The SQL parser found invalid syntax${location}.`,
      ...(plan.line !== undefined ? { line: plan.line } : {}),
      ...(plan.column !== undefined ? { column: plan.column } : {}),
    };
  }
  if (plan.reason === "budget-exhausted") {
    const budget = plan.budget;
    const usage = [
      budget ? `configured depth ${budget.maxDepth}` : undefined,
      budget ? `${budget.maxNodes.toLocaleString("en-US")} nodes` : undefined,
      plan.totalNodes !== undefined
        ? `${plan.totalNodes.toLocaleString("en-US")} nodes observed`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      version: 1,
      type: "error",
      category: "execution",
      title: "SQL analysis budget reached",
      message: `The cell was not executed because PostgreSQL Workbench could not classify the complete SQL syntax tree${usage ? ` (${usage})` : ""}. Increase the SQL analysis budget and run the cell again.`,
      action: {
        type: "open-sql-analysis-settings",
        label: "Open SQL analysis settings",
      },
    };
  }
  return notebookErrorPayload(
    "execution",
    "SQL analysis failed",
    `The SQL parser could not analyze this cell: ${plan.message}`,
  );
}

export function executionErrorPayload(
  error: unknown,
  statement?: number,
  statementTimeoutMs?: number,
): SqlNotebookErrorPayload {
  if (error instanceof DedicatedNotebookConnectionError) {
    return {
      ...notebookErrorPayload("connection", "PostgreSQL Connection error", error.message),
      ...(statement ? { statement } : {}),
    };
  }
  // A thrown object carries the same fields a debug result does; naming them is all that differs.
  const source = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = errorMessage(error);
  const failure: SqlFailure = {
    message,
    ...(stringErrorField(source, "code") ? { code: stringErrorField(source, "code") } : {}),
    ...optionalErrorField(source, "detail"),
    ...optionalErrorField(source, "hint"),
    ...optionalErrorField(source, "position"),
  };
  return {
    ...sqlFailurePayload(failure, statement),
    ...statementTimeoutRecovery(failure.code, message, statementTimeoutMs),
  };
}

export function statementTimeoutRecovery(
  code: string | undefined,
  message: string,
  statementTimeoutMs: number | undefined,
): Pick<SqlNotebookErrorPayload, "action" | "hint"> {
  if (code !== "57014" || !/statement timeout/iu.test(message)) return {};
  return {
    hint:
      statementTimeoutMs === undefined
        ? "Increase this Scratchpad's Statement timeout and run the cell again."
        : `This Scratchpad allows ${formatStatementTimeout(statementTimeoutMs)} per Statement. Increase its timeout and run the cell again.`,
    action: {
      type: "increase-scratchpad-timeout",
      label: "Increase Scratchpad timeout…",
    },
  };
}

export function executionCancelledPayload(): SqlNotebookErrorPayload {
  return notebookErrorPayload(
    "execution",
    "Execution cancelled",
    "The SQL execution was cancelled by the user.",
  );
}

function optionalErrorField<K extends "detail" | "hint" | "position">(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<SqlNotebookErrorPayload, K>> {
  const value = stringErrorField(source, key);
  return value ? ({ [key]: value } as Pick<SqlNotebookErrorPayload, K>) : {};
}

function stringErrorField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A statement timeout as a reader reads it: seconds up to a minute, then minutes. */
export function formatStatementTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1_000;
  if (seconds < 60) return `${seconds} s`;
  const minutes = seconds / 60;
  return `${minutes} min`;
}
