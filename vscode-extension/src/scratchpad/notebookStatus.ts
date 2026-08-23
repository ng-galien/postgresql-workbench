import * as vscode from "vscode";
import type { ScratchpadAssociationSnapshot } from "../../../packages/rows/src/resultPayload.js";
import type { ConnectionManager } from "../connection/index.js";
import {
  normalizeMetadata,
  resolveScratchpadAssociation,
  scratchpadCellExecutionIntent,
  scratchpadExecutionMode,
  scratchpadStatementTimeoutMs,
} from "./notebookFile.js";
import { formatStatementTimeout } from "./notebookOutput.js";
import {
  CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
  type ScratchpadDebugEligibility,
  SET_SCRATCHPAD_CELL_EXECUTION_INTENT_COMMAND,
  SET_SCRATCHPAD_STATEMENT_TIMEOUT_COMMAND,
} from "./registerCommands.js";
import { configuredScratchpadStatementTimeoutMs } from "./scratchpadSettings.js";

/**
 * What a Scratchpad cell says about itself under its own last line: which Connexion it will run
 * on, how long a statement may take, and whether the routine it names can be debugged. Recomputed
 * when the notebook changes, and after a pause when the cell's own text does — analysing a routine
 * on every keystroke would ask PostgreSQL a question the reader has not finished writing.
 */

const DEBUGGABLE_ANALYSIS_DELAY_MS = 500;

export class SqlNotebookStatusProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  private readonly debuggable = new Map<string, { version: number; value?: boolean }>();
  private readonly debuggableTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly canDebug: ScratchpadDebugEligibility,
  ) {
    this.subscriptions = [
      connections.onChanged(() => this.invalidateDebuggable()),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        for (const cell of notebook.getCells())
          this.debuggable.delete(cell.document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench.sql.statementTimeoutMs")) {
          this.changed.fire();
        }
      }),
    ];
  }

  invalidateDebuggable(): void {
    for (const timer of this.debuggableTimers.values()) clearTimeout(timer);
    this.debuggableTimers.clear();
    this.debuggable.clear();
    this.changed.fire();
  }

  /** Last known Debug eligibility of a cell; false until the analysis has completed. */
  isDebuggable(cell: vscode.NotebookCell): boolean {
    const cached = this.debuggable.get(cell.document.uri.toString());
    return cached?.version === cell.document.version && cached.value === true;
  }

  private requestDebuggable(
    cell: vscode.NotebookCell,
    association: ScratchpadAssociationSnapshot,
  ): boolean {
    const key = cell.document.uri.toString();
    const version = cell.document.version;
    const cached = this.debuggable.get(key);
    if (cached?.version === version) return cached.value === true;
    // Debounce: typing bumps the version on every keystroke; analyse only the settled text.
    clearTimeout(this.debuggableTimers.get(key));
    this.debuggable.set(key, { version });
    const sql = cell.document.getText();
    this.debuggableTimers.set(
      key,
      setTimeout(() => {
        this.debuggableTimers.delete(key);
        if (this.debuggable.get(key)?.version !== version) return;
        void this.canDebug({ sql, association })
          .then((value) => {
            if (this.debuggable.get(key)?.version !== version) return;
            this.debuggable.set(key, { version, value });
            if (value) this.changed.fire();
          })
          .catch(() => {
            if (this.debuggable.get(key)?.version === version) this.debuggable.delete(key);
          });
      }, DEBUGGABLE_ANALYSIS_DELAY_MS),
    );
    return false;
  }

  provideCellStatusBarItems(
    cell: vscode.NotebookCell,
  ): vscode.NotebookCellStatusBarItem[] | undefined {
    if (cell.kind === vscode.NotebookCellKind.Markup) return undefined;
    const executionIntent = scratchpadCellExecutionIntent(cell.metadata);
    const manualMode =
      scratchpadExecutionMode(normalizeMetadata(cell.notebook.metadata)) === "manual";
    const intentItem = new vscode.NotebookCellStatusBarItem(
      executionIntent === "debug" ? "$(debug-alt) Debug" : "$(play) Run",
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    intentItem.command = {
      title: "Change cell execution intent",
      command: SET_SCRATCHPAD_CELL_EXECUTION_INTENT_COMMAND,
      arguments: [cell],
    };
    intentItem.tooltip =
      executionIntent === "debug"
        ? "Execution intent: Debug — the cell action attaches the PL/pgSQL debugger. Click to choose Run or Debug."
        : "Execution intent: Run — click to choose Run or Debug.";
    intentItem.priority = 101;
    const association = resolveScratchpadAssociation(
      normalizeMetadata(cell.notebook.metadata),
      this.connections.servers,
    );
    const connected =
      association.status === "associated" &&
      this.connections.isServerConnected(association.connection.id);
    const label =
      association.status === "unassociated"
        ? "Choose a Connexion"
        : association.snapshot.serverName;
    const associationItem = new vscode.NotebookCellStatusBarItem(
      `${association.status === "associated" ? (connected ? "$(pass-filled)" : "$(circle-outline)") : "$(warning)"} ${label}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    associationItem.command = {
      title: "Change Scratchpad Connexion",
      command: CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
      arguments: [cell.notebook],
    };
    associationItem.tooltip =
      association.status === "associated"
        ? `Scratchpad Connexion ${connected ? "connected" : "disconnected"} — click to change it`
        : "Scratchpad Association unavailable — click to change its Connexion";
    associationItem.priority = 100;
    const metadata = normalizeMetadata(cell.notebook.metadata);
    const globalTimeoutMs = configuredScratchpadStatementTimeoutMs();
    const timeoutMs = scratchpadStatementTimeoutMs(metadata, globalTimeoutMs);
    const timeoutItem = new vscode.NotebookCellStatusBarItem(
      `$(clock) Timeout: ${formatStatementTimeout(timeoutMs)}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    timeoutItem.command = {
      title: "Change Scratchpad Statement timeout",
      command: SET_SCRATCHPAD_STATEMENT_TIMEOUT_COMMAND,
      arguments: [cell.notebook],
    };
    timeoutItem.tooltip =
      metadata.statementTimeoutMs === undefined
        ? "Scratchpad Statement timeout from the global setting — click to change"
        : "Scratchpad Statement timeout override — click to change or use the global setting";
    timeoutItem.priority = 99;
    if (manualMode) return [associationItem, timeoutItem];
    const debuggable =
      association.status === "associated" && this.requestDebuggable(cell, association.snapshot);
    if (!debuggable) return [associationItem, timeoutItem];
    return executionIntent === "debug"
      ? [intentItem, associationItem]
      : [intentItem, associationItem, timeoutItem];
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    for (const timer of this.debuggableTimers.values()) clearTimeout(timer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
