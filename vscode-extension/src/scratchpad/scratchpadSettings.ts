import * as vscode from "vscode";
import {
  clampDebugResultRows,
  DEBUG_RESULT_LIMITS,
} from "../../../packages/dap/src/debugger/launch/index.js";
import {
  DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS,
  validStatementTimeoutMs,
} from "../../../packages/scratchpad/src/notebookFile.js";

/**
 * What the reader has configured for a Scratchpad: how long a statement may run before PostgreSQL
 * is told to stop, and how many rows a result holds on to. Read at every use rather than kept,
 * because a reader may change either while a Scratchpad is open.
 */

export interface SqlResultSettings {
  pageSize: number;
  maxCellBytes: number;
  nonPagedMaxRows: number;
}

export function sqlResultSettings(): SqlResultSettings {
  const configuration = vscode.workspace.getConfiguration("postgresql-workbench.results");
  const pageSizeInspection = configuration.inspect<number>("pageSize");
  const pageSizeExplicit =
    pageSizeInspection?.workspaceFolderValue ??
    pageSizeInspection?.workspaceValue ??
    pageSizeInspection?.globalValue;
  const legacyRows = configuration.get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS);
  const pageSize = clampDebugResultRows(
    pageSizeExplicit ?? configuration.get<number>("pageSize", legacyRows),
  );
  return {
    pageSize,
    maxCellBytes: Math.max(
      64 * 1024,
      Math.min(8 * 1024 * 1024, Math.trunc(configuration.get<number>("maxCellBytes", 256 * 1024))),
    ),
    nonPagedMaxRows: clampDebugResultRows(
      configuration.get<number>("nonPagedMaxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS),
    ),
  };
}

/** The reader's statement timeout, or the default when what they set is not a timeout. */
export function configuredScratchpadStatementTimeoutMs(): number {
  const value = vscode.workspace
    .getConfiguration("postgresql-workbench.sql")
    .get<number>("statementTimeoutMs", DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS);
  return validStatementTimeoutMs(value) ?? DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS;
}
