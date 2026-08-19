import type { Client } from "pg";
import type * as vscode from "vscode";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
  SqlAuthoringDragPayload,
  SqlAuthoringSettings,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/authoring/protocol.js";
import type { DataViewSource } from "../../../packages/views/src/dataView/protocol.js";
import type { DataViewQueryFileSystem } from "./queryFileSystem.js";

export interface DataViewResultSettings {
  pageSize: number;
  maxCachedRows: number;
  cursorIdleTimeoutSeconds: number;
}

/** Everything a Data View needs from the Extension Host, injected so the module stays testable. */
export interface DataViewHostServices {
  /** Opens a dedicated PostgreSQL client for the saved Connexion; rejects when it is unavailable. */
  openClient(serverId: string): Promise<Client>;
  /** Display name of the saved Connexion — its alias when set, its URL otherwise. */
  serverName(serverId: string): string | undefined;
  /**
   * Notifies the Data View when saved Connexions change, so it can restate its Association.
   * `serverIds` empty means every Connexion; nothing is emitted for changes a Data View cannot show.
   */
  onConnectionsChanged(listener: (serverIds: readonly string[]) => void): vscode.Disposable;
  resultSettings(): DataViewResultSettings;
  /** Opens the SQL of a Data View in a Scratchpad for free-form refinement. */
  openSql(source: DataViewSource, sql: string): Promise<void>;
  parser(): Promise<SyntaxParser>;
  /** Composes through the SQL authoring server: the same guarded entry a Scratchpad drop uses. */
  compose(request: SqlAuthoringComposeRequest): Promise<SqlAuthoringComposeResult>;
  authoringSnapshot(serverId: string, database: string): SqlAuthoringSnapshot | undefined;
  authoringSettings(uri: string): SqlAuthoringSettings;
  queryFiles: DataViewQueryFileSystem;
  /** SQL authoring payload of the tree item being dragged, if any (consumed on read). */
  treeDragPayload(consume: boolean): SqlAuthoringDragPayload | undefined;
  /** Registers the Document Association of a query document so SQL authoring resolves it. */
  associate(documentUri: string, serverId: string): Promise<void>;
  dissociate(documentUri: string): Promise<void>;
  output: vscode.OutputChannel;
  extensionUri: vscode.Uri;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
