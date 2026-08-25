import type * as vscode from "vscode";

import {
  type ConnectionConfig,
  getConnectionName,
  getConnectionUrl,
  getCustomConnectionName,
  sameConnectionIdentity,
} from "../../../packages/catalog/src/savedConnection.js";

/**
 * Historical storage keys retained verbatim so existing saved Connections and per-workspace open
 * intent remain readable. `server` was the former domain term; new code uses Connection.
 */
const CONNECTIONS_STORAGE_KEY = "postgresql-workbench.servers";
const PASSWORD_PREFIX = "postgresql-workbench.pw.";
const OPEN_CONNECTIONS_STORAGE_KEY = "postgresql-workbench.openServers";

/**
 * Persists connection configs in globalState and passwords in VS Code secrets.
 */
export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Connection CRUD ---

  getAll(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_STORAGE_KEY) ?? [];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.getAll().find((s) => s.id === id);
  }

  has(id: string): boolean {
    return this.getAll().some((s) => s.id === id);
  }

  async add(connection: ConnectionConfig, password: string): Promise<void> {
    const connections = this.getAll();
    this.assertUnique(connection, connections);
    connections.push(normalizeConnection(connection));
    await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, connections);
    await this.context.secrets.store(PASSWORD_PREFIX + connection.id, password);
  }

  async update(oldId: string, connection: ConnectionConfig, password?: string): Promise<void> {
    const connections = this.getAll().filter((s) => s.id !== oldId);
    this.assertUnique(connection, connections);
    connections.push(normalizeConnection(connection));
    await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, connections);
    if (password !== undefined) {
      await this.context.secrets.store(PASSWORD_PREFIX + connection.id, password);
    } else if (oldId !== connection.id) {
      const existing = await this.getPassword(oldId);
      if (existing) await this.context.secrets.store(PASSWORD_PREFIX + connection.id, existing);
    }
    if (oldId !== connection.id) {
      await this.context.secrets.delete(PASSWORD_PREFIX + oldId);
      const open = this.getOpenConnectionIds();
      if (open.includes(oldId)) {
        await this.setConnectionOpen(oldId, false);
        await this.setConnectionOpen(connection.id, true);
      }
    }
  }

  async remove(id: string): Promise<void> {
    const connections = this.getAll().filter((s) => s.id !== id);
    await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, connections);
    await this.context.secrets.delete(PASSWORD_PREFIX + id);
    await this.setConnectionOpen(id, false);
  }

  // --- Password ---

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(PASSWORD_PREFIX + id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(PASSWORD_PREFIX + id, password);
  }

  // --- Per-Connection open intent (per workspace) ---

  getOpenConnectionIds(): string[] {
    return this.context.workspaceState.get<string[]>(OPEN_CONNECTIONS_STORAGE_KEY) ?? [];
  }

  async setConnectionOpen(id: string, open: boolean): Promise<void> {
    const ids = new Set(this.getOpenConnectionIds());
    if (open) ids.add(id);
    else ids.delete(id);
    await this.context.workspaceState.update(OPEN_CONNECTIONS_STORAGE_KEY, [...ids]);
  }

  // --- Helpers ---

  static makeId(host: string, port: number, database: string, user: string): string {
    return `${host}:${port}/${database}:${user}`;
  }

  static makeName(host: string, port: number, database: string, user: string): string {
    return getConnectionUrl({ host, port, database, user });
  }

  isConnectionNameAvailable(name: string, exceptId?: string): boolean {
    const normalized = normalizedName(name);
    if (!normalized) return true;
    return !this.getAll().some(
      (connection) =>
        connection.id !== exceptId && normalizedName(getConnectionName(connection)) === normalized,
    );
  }

  private assertUnique(connection: ConnectionConfig, existing: readonly ConnectionConfig[]): void {
    if (existing.some((candidate) => sameConnectionIdentity(candidate, connection))) {
      throw new Error(`Connection URL ${getConnectionUrl(connection)} is already saved.`);
    }
    const name = getConnectionName(connection);
    const normalized = normalizedName(name);
    if (existing.some((candidate) => normalizedName(getConnectionName(candidate)) === normalized)) {
      throw new Error(`Connection name ${name} is already used.`);
    }
  }
}

function normalizeConnection(connection: ConnectionConfig): ConnectionConfig {
  return { ...connection, name: getCustomConnectionName(connection) };
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
