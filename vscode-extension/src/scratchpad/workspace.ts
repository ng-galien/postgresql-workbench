import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import {
  nextSqlNotebookName,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  SQL_NOTEBOOK_EXTENSION,
  type SqlNotebookMetadata,
} from "../../../packages/scratchpad/src/notebookFile.js";
import { SQL_NOTEBOOK_SCHEME, type SqlNotebookFileSystemProvider } from "./fileSystem.js";

export const OPEN_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.openSqlNotebook";
export const RENAME_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.renameSqlNotebook";
export const DELETE_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.deleteSqlNotebook";
export const REFRESH_SQL_NOTEBOOKS_COMMAND = "postgresql-workbench.refreshSqlNotebooks";
export const DUPLICATE_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.duplicateSqlNotebook";
export const EXPORT_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.exportSqlNotebook";

export interface SqlNotebookEntry {
  uri: vscode.Uri;
  name: string;
  metadata: SqlNotebookMetadata;
  error?: string;
}

export class SqlNotebookWorkspace implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeEntries = this.changed.event;
  readonly rootUri: vscode.Uri;
  private readonly subscription: vscode.Disposable;
  private creationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly fileSystem: SqlNotebookFileSystemProvider) {
    this.rootUri = vscode.Uri.from({ scheme: SQL_NOTEBOOK_SCHEME, path: "/" });
    this.subscription = fileSystem.onDidChangeFile(() => this.refresh());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire();
  }

  async list(): Promise<SqlNotebookEntry[]> {
    const files = await this.readDirectory();
    const entries = await Promise.all(
      files
        .filter(([name, type]) => type === vscode.FileType.File && isSqlNotebookName(name))
        .map(async ([name]) => {
          const uri = this.fileSystem.uri(name);
          const state = await readNotebookMetadata(uri);
          return { uri, name, ...state } satisfies SqlNotebookEntry;
        }),
    );
    return entries.sort((left, right) => right.name.localeCompare(left.name));
  }

  async entry(
    target?: SqlNotebookEntry | vscode.Uri | string,
  ): Promise<SqlNotebookEntry | undefined> {
    const entries = await this.list();
    if (!target) return undefined;
    const targetUri = notebookUri(target);
    return entries.find((entry) => entry.uri.toString() === targetUri?.toString());
  }

  async rename(entry: SqlNotebookEntry, requestedName: string): Promise<vscode.Uri> {
    const name = normalizeSqlNotebookName(requestedName);
    const target = this.fileSystem.uri(name);
    if (target.toString() === entry.uri.toString()) return target;
    await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
    return target;
  }

  create(content: Uint8Array): Promise<vscode.Uri> {
    const operation = this.creationQueue.then(async () => {
      const existingNames = (await this.list()).map(({ name }) => name);
      const uri = this.fileSystem.uri(nextSqlNotebookName(existingNames));
      await this.fileSystem.writeFile(uri, content, { create: true, overwrite: false });
      return uri;
    });
    this.creationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async delete(entry: SqlNotebookEntry): Promise<void> {
    await vscode.workspace.fs.delete(entry.uri, { recursive: false, useTrash: false });
  }

  private async readDirectory(): Promise<[string, vscode.FileType][]> {
    try {
      return await vscode.workspace.fs.readDirectory(this.rootUri);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
      await vscode.workspace.fs.createDirectory(this.rootUri);
      return [];
    }
  }
}

function notebookUri(target: SqlNotebookEntry | vscode.Uri | string): vscode.Uri | undefined {
  if (typeof target === "string") return vscode.Uri.parse(target);
  return "uri" in target ? target.uri : target;
}

async function readNotebookMetadata(
  uri: vscode.Uri,
): Promise<{ metadata: SqlNotebookMetadata; error?: string }> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return { metadata: parseSqlNotebookFile(new TextDecoder().decode(content)).metadata };
  } catch (error) {
    return {
      metadata: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isSqlNotebookName(name: string): boolean {
  return name.endsWith(SQL_NOTEBOOK_EXTENSION) && !name.includes("/");
}

export function sqlNotebookDisplayName(name: string): string {
  return name.endsWith(SQL_NOTEBOOK_EXTENSION)
    ? name.slice(0, -SQL_NOTEBOOK_EXTENSION.length)
    : name;
}
