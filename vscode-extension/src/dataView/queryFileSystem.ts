import * as vscode from "vscode";

export const DATA_VIEW_QUERY_SCHEME = "postgresql-workbench-data-sql";

interface QueryFile {
  content: Uint8Array;
  ctime: number;
  mtime: number;
  onWrite?: (text: string, reason: vscode.TextDocumentSaveReason | undefined) => void;
}

/**
 * In-memory files holding the SQL of open Data Views. They are real, writable text documents so
 * the SQL authoring server, semantic tokens, and formatting apply; saving one reloads its view.
 */
export class DataViewQueryFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, QueryFile>();
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly registration: vscode.Disposable;
  /** Save reason of the write about to happen, per file (manual save vs. auto save). */
  private readonly pendingSaveReasons = new Map<string, vscode.TextDocumentSaveReason>();

  constructor() {
    this.registration = vscode.Disposable.from(
      vscode.workspace.registerFileSystemProvider(DATA_VIEW_QUERY_SCHEME, this, {
        isCaseSensitive: true,
        isReadonly: false,
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document.uri.scheme === DATA_VIEW_QUERY_SCHEME) {
          this.pendingSaveReasons.set(event.document.uri.toString(), event.reason);
        }
      }),
    );
  }

  /** Creates or replaces a query file; `onWrite` receives text saved from an editor. */
  set(
    uri: vscode.Uri,
    text: string,
    onWrite?: (text: string, reason: vscode.TextDocumentSaveReason | undefined) => void,
  ): void {
    const key = uri.toString();
    const existing = this.files.get(key);
    const now = Date.now();
    this.files.set(key, {
      content: Buffer.from(text, "utf8"),
      ctime: existing?.ctime ?? now,
      mtime: now,
      onWrite: onWrite ?? existing?.onWrite,
    });
    this._onDidChangeFile.fire([
      { type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  text(uri: vscode.Uri): string | undefined {
    const file = this.files.get(uri.toString());
    return file ? Buffer.from(file.content).toString("utf8") : undefined;
  }

  remove(uri: vscode.Uri): void {
    if (!this.files.delete(uri.toString())) return;
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.files.get(uri.toString());
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: file.ctime,
      mtime: file.mtime,
      size: file.content.byteLength,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {}

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.files.get(uri.toString());
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    return file.content;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const file = this.files.get(uri.toString());
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    file.content = content;
    file.mtime = Date.now();
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    const reason = this.pendingSaveReasons.get(uri.toString());
    this.pendingSaveReasons.delete(uri.toString());
    file.onWrite?.(Buffer.from(content).toString("utf8"), reason);
  }

  delete(uri: vscode.Uri): void {
    this.remove(uri);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Data View queries cannot be renamed.");
  }

  dispose(): void {
    this.registration.dispose();
    this._onDidChangeFile.dispose();
    this.files.clear();
  }
}
