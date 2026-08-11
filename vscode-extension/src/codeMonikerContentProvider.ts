import type { Client } from "pg";
import * as vscode from "vscode";
import { CODE_MONIKER_URI_SCHEME, codeMonikerUriString } from "./codeMonikerUri.js";
import type { ConnectionManager } from "./connectionManager.js";
import { openCoverageClient } from "./coverageConnection.js";
import type {
  WorkbenchIndexController,
  WorkbenchSourceDescriptor,
} from "./workbenchIndexController.js";

export class CodeMonikerContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly SCHEME = CODE_MONIKER_URI_SCHEME;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly subscriptions: vscode.Disposable[];
  private closingUnavailableTabs: Promise<void> | undefined;
  private unavailableTabsReconciliationRequested = false;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
  ) {
    this.subscriptions = [
      connections.onServerChanged(() => {
        this.invalidateAll();
        this.reconcileUnavailableTabs();
      }),
      index.onDidChangeState(() => {
        this.invalidateAll();
        this.reconcileUnavailableTabs();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.reconcileUnavailableTabs()),
    ];
    queueMicrotask(() => this.reconcileUnavailableTabs());
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeEmitter.dispose();
    this.cache.clear();
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private reconcileUnavailableTabs(): void {
    this.unavailableTabsReconciliationRequested = true;
    if (this.closingUnavailableTabs) return;
    this.closingUnavailableTabs = this.closeUnavailableTabsUntilSettled().finally(() => {
      this.closingUnavailableTabs = undefined;
    });
    void this.closingUnavailableTabs.catch(() => {});
  }

  private async closeUnavailableTabsUntilSettled(): Promise<void> {
    while (this.unavailableTabsReconciliationRequested) {
      this.unavailableTabsReconciliationRequested = false;
      await closeUnavailableCodeMonikerTabs((uri) =>
        Boolean(this.index.sourceDescriptorForDocumentUri(uri)),
      );
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const descriptor = this.index.sourceDescriptorForDocumentUri(uri);
    if (!descriptor) {
      if (this.directoryEntries(uri).length > 0) {
        return {
          type: vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: 0,
        };
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const key = descriptor.symbolUri;
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: this.cache.get(key)?.length ?? new TextEncoder().encode(descriptor.content).length,
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const entries = this.directoryEntries(uri);
    if (entries.length === 0) throw vscode.FileSystemError.FileNotFound(uri);
    return entries;
  }

  createDirectory(): void {}

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Cannot delete PostgreSQL objects via filesystem");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Cannot rename PostgreSQL objects via filesystem");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const descriptor = this.requireDescriptor(uri);
    if (!descriptor.plpgsql) {
      throw vscode.FileSystemError.NoPermissions("Only PL/pgSQL routines can be deployed");
    }
    const connection = await connectionForDescriptor(this.connections, descriptor);
    await deployRoutine(connection, content);
    const key = descriptor.symbolUri;
    this.cache.set(key, content);
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const descriptor = this.requireDescriptor(uri);
    const cached = this.cache.get(descriptor.symbolUri);
    if (cached) return cached;
    const bytes = new TextEncoder().encode(descriptor.content);
    this.cache.set(descriptor.symbolUri, bytes);
    return bytes;
  }

  private requireDescriptor(uri: vscode.Uri): WorkbenchSourceDescriptor {
    const symbolUri = codeMonikerUriString(uri);
    const descriptor = this.index.sourceDescriptorForDocumentUri(uri);
    if (!descriptor) {
      throw vscode.FileSystemError.FileNotFound(
        `Code Moniker symbol is not available in the current PostgreSQL index: ${symbolUri}`,
      );
    }
    return descriptor;
  }

  private directoryEntries(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.path.endsWith("/") ? uri.path : `${uri.path}/`;
    const entries = new Map<string, vscode.FileType>();
    for (const candidate of this.index.sourceDocumentUris()) {
      if (candidate.scheme !== uri.scheme || candidate.authority !== uri.authority) continue;
      if (!candidate.path.startsWith(prefix)) continue;
      const remainder = candidate.path.slice(prefix.length);
      const separator = remainder.indexOf("/");
      const name = separator === -1 ? remainder : remainder.slice(0, separator);
      if (!name) continue;
      entries.set(name, separator === -1 ? vscode.FileType.File : vscode.FileType.Directory);
    }
    return [...entries.entries()];
  }
}

export async function closeUnavailableCodeMonikerTabs(
  isAvailable: (uri: vscode.Uri) => boolean,
): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        !tab.isDirty &&
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.scheme === CodeMonikerContentProvider.SCHEME &&
        !isAvailable(tab.input.uri),
    ),
  );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
}

interface UriConnection {
  client: Client;
  owned: boolean;
}

async function deployRoutine(connection: UriConnection, content: Uint8Array): Promise<void> {
  const sql = new TextDecoder().decode(content);
  try {
    await connection.client.query(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Deploy failed: ${message}`);
    throw vscode.FileSystemError.NoPermissions(message);
  } finally {
    if (connection.owned) await connection.client.end().catch(() => {});
  }
}

async function connectionForDescriptor(
  connections: ConnectionManager,
  descriptor: WorkbenchSourceDescriptor,
): Promise<UriConnection> {
  if (descriptor.serverId === connections.activeServer?.id) {
    const client = connections.getClient();
    if (client) return { client, owned: false };
  }
  return {
    client: await openCoverageClient(connections, descriptor.serverId),
    owned: true,
  };
}
