export { errorMessage } from "../errorMessage.js";

import type { Client } from "pg";
import type * as vscode from "vscode";
import type { DataViewSource } from "../../../packages/rows/src/dataView/dataView.js";
import type { DataViewResultSettings } from "../../../packages/rows/src/dataView/openRows.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
} from "../../../packages/sql/src/languageServer/protocol.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSettings,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/snapshot.js";
import type { DataViewQueryFileSystem } from "./queryFileSystem.js";

/** Everything a Data View needs from the Extension Host, injected so the module stays testable. */
export interface DataViewHostServices {
  /** Opens a dedicated PostgreSQL client for the saved Connection; rejects when it is unavailable. */
  openClient(connectionId: string): Promise<Client>;
  /** Display name of the saved Connection — its alias when set, its URL otherwise. */
  connectionName(connectionId: string): string | undefined;
  /**
   * Notifies the Data View when saved Connections change, so it can restate its Association.
   * `connectionIds` empty means every Connection; nothing is emitted for changes a Data View cannot show.
   */
  onConnectionsChanged(listener: (connectionIds: readonly string[]) => void): vscode.Disposable;
  resultSettings(): DataViewResultSettings;
  /** Opens the SQL of a Data View in a Scratchpad for free-form refinement. */
  openSql(source: DataViewSource, sql: string): Promise<void>;
  parser(): Promise<SyntaxParser>;
  /** Composes through the SQL authoring server: the same guarded entry a Scratchpad drop uses. */
  compose(request: SqlAuthoringComposeRequest): Promise<SqlAuthoringComposeResult>;
  authoringSnapshot(connectionId: string, database: string): SqlAuthoringSnapshot | undefined;
  authoringSettings(uri: string): SqlAuthoringSettings;
  queryFiles: DataViewQueryFileSystem;
  /** SQL authoring payload of the tree item being dragged, if any (consumed on read). */
  treeDragPayload(consume: boolean): SqlAuthoringDragPayload | undefined;
  /** Registers the Document Association of a query document so SQL authoring resolves it. */
  associate(documentUri: string, connectionId: string): Promise<void>;
  dissociate(documentUri: string): Promise<void>;
  output: vscode.OutputChannel;
  extensionUri: vscode.Uri;
  /** Loopback LSP endpoint materialized by the VS Code SQL-authoring adapter. */
  sqlEditorLanguageServerUrl(): string;
}
