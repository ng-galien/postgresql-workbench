import * as vscode from "vscode";
import { SQL_NOTEBOOK_EXTENSION } from "./sqlNotebookModel.js";

export const SQL_NOTEBOOK_SCHEME = "postgresql-workbench";

export class SqlNotebookFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  readonly storageDirectory: vscode.Uri;

  constructor(globalStorageUri: vscode.Uri) {
    this.storageDirectory = vscode.Uri.joinPath(globalStorageUri, "sql-notebooks");
  }

  dispose(): void {
    this.changed.dispose();
  }

  uri(name: string): vscode.Uri {
    if (!isNotebookName(name)) throw vscode.FileSystemError.NoPermissions(name);
    return vscode.Uri.from({ scheme: SQL_NOTEBOOK_SCHEME, path: `/${name}` });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return vscode.workspace.fs.stat(this.storageUri(uri));
  }

  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(this.storageUri(uri));
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageUri(uri));
    this.changed.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  readFile(uri: vscode.Uri): Thenable<Uint8Array> {
    return vscode.workspace.fs.readFile(this.storageUri(uri));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const storageUri = this.storageUri(uri);
    const exists = await fileExists(storageUri);
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    await vscode.workspace.fs.writeFile(storageUri, content);
    this.changed.fire([
      { type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    await vscode.workspace.fs.delete(this.storageUri(uri), options);
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    await vscode.workspace.fs.rename(this.storageUri(oldUri), this.storageUri(newUri), options);
    this.changed.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  private storageUri(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme !== SQL_NOTEBOOK_SCHEME) throw vscode.FileSystemError.NoPermissions(uri);
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length === 0) return this.storageDirectory;
    if (parts.length !== 1 || !isNotebookName(parts[0] ?? "")) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    return vscode.Uri.joinPath(this.storageDirectory, parts[0]!);
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return false;
    throw error;
  }
}

function isNotebookName(name: string): boolean {
  return Boolean(name) && !name.includes("/") && name.endsWith(SQL_NOTEBOOK_EXTENSION);
}
