import type { Client } from "pg";
import type * as vscode from "vscode";
import type { SyntaxParser } from "../../../src/analysis/syntaxTree.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSettings,
  SqlAuthoringSnapshot,
} from "../sqlAuthoring/protocol.js";
import type { DataViewSource } from "./protocol.js";
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
  serverName(serverId: string): string | undefined;
  resultSettings(): DataViewResultSettings;
  /** Opens the SQL of a Data View in a Scratchpad for free-form refinement. */
  openSql(source: DataViewSource, sql: string): Promise<void>;
  parser(): Promise<SyntaxParser>;
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
