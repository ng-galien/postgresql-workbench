import type * as vscode from "vscode";

/**
 * A saved server entry (no password — stored separately in secrets).
 */
export type SslMode = "disable" | "prefer" | "require";

export interface ServerConfig {
  /** Unique key: "host:port/database:user" */
  id: string;
  /** Display name: "user@host:port/database" */
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: SslMode;
  /** Optional per-DatabaseContext overrides for Workbench schema synchronization. */
  schemaSync?: {
    enabled?: boolean;
    supportSchema?: string;
  };
}

export function sameDatabaseContextIdentity(
  left: Pick<ServerConfig, "host" | "port" | "database" | "user">,
  right: Pick<ServerConfig, "host" | "port" | "database" | "user">,
): boolean {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.user === right.user
  );
}

const SERVERS_KEY = "postgresql-workbench.servers";
const PASSWORD_PREFIX = "postgresql-workbench.pw.";
const ACTIVE_SERVER_KEY = "postgresql-workbench.activeServer";

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
    const servers = this.getAll().filter((s) => s.id !== server.id);
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
    await this.context.secrets.store(PASSWORD_PREFIX + server.id, password);
  }

  async update(oldId: string, server: ServerConfig, password?: string): Promise<void> {
    const servers = this.getAll().filter((s) => s.id !== oldId);
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
    if (password !== undefined) {
      await this.context.secrets.store(PASSWORD_PREFIX + server.id, password);
    } else if (oldId !== server.id) {
      const existing = await this.getPassword(oldId);
      if (existing) await this.context.secrets.store(PASSWORD_PREFIX + server.id, existing);
    }
    if (oldId !== server.id) {
      await this.context.secrets.delete(PASSWORD_PREFIX + oldId);
      if (this.getActiveServerId() === oldId) await this.setActiveServerId(server.id);
    }
  }

  async remove(id: string): Promise<void> {
    const servers = this.getAll().filter((s) => s.id !== id);
    await this.context.globalState.update(SERVERS_KEY, servers);
    await this.context.secrets.delete(PASSWORD_PREFIX + id);
    if (this.getActiveServerId() === id) {
      await this.setActiveServerId(undefined);
    }
  }

  // --- Password ---

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(PASSWORD_PREFIX + id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(PASSWORD_PREFIX + id, password);
  }

  // --- Active server (per workspace) ---

  getActiveServerId(): string | undefined {
    return this.context.workspaceState.get<string>(ACTIVE_SERVER_KEY);
  }

  async setActiveServerId(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_SERVER_KEY, id);
  }

  // --- Helpers ---

  static makeId(host: string, port: number, database: string, user: string): string {
    return `${host}:${port}/${database}:${user}`;
  }

  static makeName(host: string, port: number, database: string, user: string): string {
    return `${user}@${host}:${port}/${database}`;
  }
}
