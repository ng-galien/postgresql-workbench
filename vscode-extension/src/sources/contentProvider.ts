import type { Client } from "pg";
import * as vscode from "vscode";
import type { ConnectionManager } from "../connection/index.js";
import { openCoverageClient } from "../coverage/index.js";
import { validateManagedRoutineDeployment } from "../plpgsql/deployRoutine.js";
import type { WorkbenchIndexController, WorkbenchSourceDescriptor } from "../workbench/index.js";
import { CODE_MONIKER_URI_SCHEME, codeMonikerUriString } from "./uri.js";

interface ManagedWorkingCopyState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface ManagedWorkingCopy {
  baseContent?: string;
  content: Uint8Array;
}

interface PersistedManagedWorkingCopy {
  baseContent?: string;
  source: string;
}

export type ManagedRoutineDeploymentResult =
  | { status: "deployed" }
  | { status: "deployed-with-warning"; message: string };

const MANAGED_WORKING_COPIES_STATE = "postgresql-workbench.managedRoutineWorkingCopies";

export class CodeMonikerContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly SCHEME = CODE_MONIKER_URI_SCHEME;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly cacheServers = new Map<string, string>();
  private readonly workingCopies = new Map<string, ManagedWorkingCopy>();
  private readonly openBases = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[];
  private closingUnavailableTabs: Promise<void> | undefined;
  private unavailableTabsReconciliationRequested = false;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
    private readonly output?: vscode.OutputChannel,
    private readonly state?: ManagedWorkingCopyState,
  ) {
    for (const [symbolUri, persisted] of Object.entries(
      state?.get<Record<string, string | PersistedManagedWorkingCopy>>(
        MANAGED_WORKING_COPIES_STATE,
        {},
      ) ?? {},
    )) {
      this.workingCopies.set(symbolUri, {
        content: new TextEncoder().encode(
          typeof persisted === "string" ? persisted : persisted.source,
        ),
        ...(typeof persisted === "string" || persisted.baseContent === undefined
          ? {}
          : { baseContent: persisted.baseContent }),
      });
    }
    this.subscriptions = [
      connections.onServerChanged((change) => {
        this.invalidateServers(change.serverIds);
        this.reconcileUnavailableTabs();
      }),
      index.onDidChangeState((state) => {
        if (state.serverId) this.invalidateServers([state.serverId]);
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
    this.cacheServers.clear();
    this.workingCopies.clear();
    this.openBases.clear();
  }

  invalidateAll(): void {
    this.cache.clear();
    this.cacheServers.clear();
  }

  private invalidateServers(serverIds: readonly string[]): void {
    const changed = new Set(serverIds);
    for (const [symbolUri, serverId] of this.cacheServers) {
      if (!changed.has(serverId)) continue;
      this.cache.delete(symbolUri);
      this.cacheServers.delete(symbolUri);
    }
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
        Boolean(
          this.index.sourceDescriptorForDocumentUri(uri) ||
            this.workingCopies.has(codeMonikerUriString(uri)),
        ),
      );
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const persisted = this.workingCopies.get(codeMonikerUriString(uri));
    if (persisted) {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: persisted.content.length,
      };
    }
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
      size:
        this.workingCopies.get(key)?.content.length ??
        this.cache.get(key)?.length ??
        new TextEncoder().encode(descriptor.content).length,
      ...(descriptor.plpgsql ? {} : { permissions: vscode.FilePermission.Readonly }),
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
    const descriptor = this.index.sourceDescriptorForDocumentUri(uri);
    if (descriptor && !descriptor.plpgsql) {
      throw vscode.FileSystemError.NoPermissions("This managed PostgreSQL source is read-only");
    }
    const key = descriptor?.symbolUri ?? codeMonikerUriString(uri);
    const existing = this.workingCopies.get(key);
    const baseContent = existing
      ? existing.baseContent
      : descriptor
        ? (this.openBases.get(key) ?? descriptor.content)
        : undefined;
    this.workingCopies.set(key, {
      content,
      ...(baseContent === undefined ? {} : { baseContent }),
    });
    await this.persistWorkingCopies();
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async deploy(uri: vscode.Uri): Promise<ManagedRoutineDeploymentResult> {
    const descriptor = this.requireDescriptor(uri);
    const workingCopy = this.workingCopies.get(descriptor.symbolUri);
    if (!workingCopy) {
      throw vscode.FileSystemError.FileNotFound("No managed routine working copy is open");
    }
    if (workingCopy.baseContent === undefined) {
      throw vscode.FileSystemError.NoPermissions(
        "No deployment base is recorded for this working copy. Reopen the routine before deploying.",
      );
    }
    if (workingCopy.baseContent !== descriptor.content) {
      throw vscode.FileSystemError.NoPermissions(
        "The deployed routine changed after this working copy was created. Compare or reopen it before deploying.",
      );
    }
    const sql = new TextDecoder().decode(workingCopy.content);
    const validation = await validateManagedRoutineDeployment(
      sql,
      descriptor,
      this.index.sqlAuthoringSnapshot({
        serverId: descriptor.serverId,
        database: descriptor.database,
      }),
      await this.index.syntaxParser(),
    );
    if (validation.status === "rejected") {
      throw vscode.FileSystemError.NoPermissions(validation.message);
    }
    const connection = await connectionForDescriptor(this.connections, descriptor);
    try {
      try {
        await connection.client.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output?.appendLine(
          `Deploy rejected by PostgreSQL: ${descriptor.schema}.${descriptor.name}: ${message}`,
        );
        throw vscode.FileSystemError.NoPermissions(
          `PostgreSQL rejected the replacement: ${message}`,
        );
      }
      try {
        await this.index.indexPostgresDatabase(connection.client, {
          serverId: descriptor.serverId,
          database: descriptor.database,
        });
      } catch (error) {
        this.index.markDatabaseStale(
          descriptor.serverId,
          descriptor.database,
          "Managed routine deployed; index refresh failed",
        );
        this.output?.appendLine(
          `Deploy refresh warning: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.output?.appendLine(
          `Deploy applied: ${descriptor.schema}.${descriptor.name} on ${descriptor.serverId}/${descriptor.database}`,
        );
        this.workingCopies.set(descriptor.symbolUri, {
          content: workingCopy.content,
          baseContent: sql,
        });
        await this.persistWorkingCopies().catch((error) => {
          this.output?.appendLine(
            `Deploy persistence warning: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return {
          status: "deployed-with-warning",
          message: "the Workbench index refresh failed and must be retried",
        };
      }
      this.workingCopies.delete(descriptor.symbolUri);
      this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      try {
        await this.persistWorkingCopies();
      } catch (error) {
        this.output?.appendLine(
          `Deploy persistence warning: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          status: "deployed-with-warning",
          message: "the saved working-copy state could not be cleared",
        };
      }
      this.output?.appendLine(
        `Deploy applied: ${descriptor.schema}.${descriptor.name} on ${descriptor.serverId}/${descriptor.database}`,
      );
      return { status: "deployed" };
    } finally {
      await connection.client.end().catch(() => {});
    }
  }

  hasWorkingCopy(uri: vscode.Uri): boolean {
    if (this.workingCopies.has(codeMonikerUriString(uri))) return true;
    const descriptor = this.index.sourceDescriptorForDocumentUri(uri);
    return descriptor ? this.workingCopies.has(descriptor.symbolUri) : false;
  }

  workingCopyDiffersFromDeployed(uri: vscode.Uri): boolean {
    const descriptor = this.index.sourceDescriptorForDocumentUri(uri);
    const workingCopy =
      this.workingCopies.get(codeMonikerUriString(uri)) ??
      (descriptor ? this.workingCopies.get(descriptor.symbolUri) : undefined);
    if (!workingCopy) return false;
    if (!descriptor) return true;
    return new TextDecoder().decode(workingCopy.content) !== descriptor.content;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const persisted = this.workingCopies.get(codeMonikerUriString(uri));
    if (persisted) return persisted.content;
    const descriptor = this.requireDescriptor(uri);
    const workingCopy = this.workingCopies.get(descriptor.symbolUri);
    if (workingCopy) return workingCopy.content;
    const cached = this.cache.get(descriptor.symbolUri);
    if (cached) return cached;
    const bytes = new TextEncoder().encode(descriptor.content);
    this.cache.set(descriptor.symbolUri, bytes);
    this.cacheServers.set(descriptor.symbolUri, descriptor.serverId);
    this.openBases.set(descriptor.symbolUri, descriptor.content);
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

  private async persistWorkingCopies(): Promise<void> {
    if (!this.state) return;
    await this.state.update(
      MANAGED_WORKING_COPIES_STATE,
      Object.fromEntries(
        [...this.workingCopies.entries()].map(([symbolUri, workingCopy]) => [
          symbolUri,
          {
            source: new TextDecoder().decode(workingCopy.content),
            ...(workingCopy.baseContent === undefined
              ? {}
              : { baseContent: workingCopy.baseContent }),
          } satisfies PersistedManagedWorkingCopy,
        ]),
      ),
    );
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
}

async function connectionForDescriptor(
  connections: ConnectionManager,
  descriptor: WorkbenchSourceDescriptor,
): Promise<UriConnection> {
  return {
    client: await openCoverageClient(connections, descriptor.serverId),
  };
}
