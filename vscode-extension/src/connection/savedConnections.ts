import type * as vscode from "vscode";

import {
  getConnectionName,
  getConnectionUrl,
  getCustomConnectionName,
  type ServerConfig,
  sameConnectionIdentity,
} from "../../../packages/catalog/src/savedConnection.js";

const SERVERS_KEY = "postgresql-workbench.servers";
const PASSWORD_PREFIX = "postgresql-workbench.pw.";
const OPEN_SERVERS_KEY = "postgresql-workbench.openServers";

/**
 * Persists server configs in globalState and passwords in VS Code secrets.
 */
export class ServerStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Server CRUD ---

  getAll(): ServerConfig[] {
    return this.context.globalState.get<ServerConfig[]>(SERVERS_KEY) ?? [];
  }

  get(id: string): ServerConfig | undefined {
    return this.getAll().find((s) => s.id === id);
  }

  has(id: string): boolean {
    return this.getAll().some((s) => s.id === id);
  }

  async add(server: ServerConfig, password: string): Promise<void> {
    const servers = this.getAll();
    this.assertUnique(server, servers);
    servers.push(normalizeServer(server));
    await this.context.globalState.update(SERVERS_KEY, servers);
    await this.context.secrets.store(PASSWORD_PREFIX + server.id, password);
  }

  async update(oldId: string, server: ServerConfig, password?: string): Promise<void> {
    const servers = this.getAll().filter((s) => s.id !== oldId);
    this.assertUnique(server, servers);
    servers.push(normalizeServer(server));
    await this.context.globalState.update(SERVERS_KEY, servers);
    if (password !== undefined) {
      await this.context.secrets.store(PASSWORD_PREFIX + server.id, password);
    } else if (oldId !== server.id) {
      const existing = await this.getPassword(oldId);
      if (existing) await this.context.secrets.store(PASSWORD_PREFIX + server.id, existing);
    }
    if (oldId !== server.id) {
      await this.context.secrets.delete(PASSWORD_PREFIX + oldId);
      const open = this.getOpenServerIds();
      if (open.includes(oldId)) {
        await this.setConnectionOpen(oldId, false);
        await this.setConnectionOpen(server.id, true);
      }
    }
  }

  async remove(id: string): Promise<void> {
    const servers = this.getAll().filter((s) => s.id !== id);
    await this.context.globalState.update(SERVERS_KEY, servers);
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

  // --- Per-Connexion open intent (per workspace) ---

  getOpenServerIds(): string[] {
    return this.context.workspaceState.get<string[]>(OPEN_SERVERS_KEY) ?? [];
  }

  async setConnectionOpen(id: string, open: boolean): Promise<void> {
    const ids = new Set(this.getOpenServerIds());
    if (open) ids.add(id);
    else ids.delete(id);
    await this.context.workspaceState.update(OPEN_SERVERS_KEY, [...ids]);
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
      (server) =>
        server.id !== exceptId && normalizedName(getConnectionName(server)) === normalized,
    );
  }

  private assertUnique(server: ServerConfig, existing: readonly ServerConfig[]): void {
    if (existing.some((candidate) => sameConnectionIdentity(candidate, server))) {
      throw new Error(`Connexion URL ${getConnectionUrl(server)} is already saved.`);
    }
    const name = getConnectionName(server);
    const normalized = normalizedName(name);
    if (existing.some((candidate) => normalizedName(getConnectionName(candidate)) === normalized)) {
      throw new Error(`Connexion name ${name} is already used.`);
    }
  }
}

function normalizeServer(server: ServerConfig): ServerConfig {
  return { ...server, name: getCustomConnectionName(server) };
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
