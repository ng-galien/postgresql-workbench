import * as vscode from "vscode";
import {
  type ConnectionConfig,
  getConnectionName,
  getCustomConnectionName,
  sameConnectionIdentity,
} from "../../../packages/catalog/src/savedConnection.js";
import type { ConnectionManager } from "./openConnections.js";
import { ConnectionStore } from "./savedConnections.js";

export class ConnectionCommands {
  constructor(private readonly connections: ConnectionManager) {}

  async addConnection(): Promise<ConnectionConfig | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: "Connection string or Host:Port",
      placeHolder: "postgresql://user:pass@localhost:5432/db  or  localhost:5432",
      value: "localhost:5432",
      ignoreFocusOut: true,
    });
    if (!input) return undefined;

    const parsed = await promptConnection(input);
    if (!parsed) return undefined;
    const id = ConnectionStore.makeId(parsed.host, parsed.port, parsed.database, parsed.user);
    if (this.connections.store.has(id)) {
      const action = await vscode.window.showInformationMessage(
        "This connection already exists.",
        "Connect",
      );
      if (action === "Connect") await this.connections.connectConnection(id);
      return this.connections.store.get(id);
    }

    const connection: ConnectionConfig = {
      id,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      ssl: parsed.ssl,
    };
    await this.connections.store.add(connection, parsed.password);
    this.connections.notifyConfigurationChanged();
    await this.connections.connectConnection(id);
    return connection;
  }

  async removeConnection(id: string): Promise<void> {
    const connection = this.connections.store.get(id);
    if (!connection) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove connection "${getConnectionName(connection)}"? Its saved password will be deleted.`,
      { modal: true },
      "Remove",
    );
    if (confirm !== "Remove") return;
    await this.connections.removeConnectionConfiguration(id);
  }

  /** Picks, imports, or creates a Connection and returns the connected connection id. */
  async pickConnection(): Promise<string | undefined> {
    const external = [...loadSqlToolsConnections(), ...loadPgsqlConnections()];
    const newExternal = external.filter((connection) => !this.connections.store.has(connection.id));
    const items = connectionQuickPickItems(this.connections, newExternal);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a PostgreSQL connection",
    });
    if (!picked?.target) return undefined;
    switch (picked.target.kind) {
      case "add": {
        const added = await this.addConnection();
        return added && this.connections.isConnectionConnected(added.id) ? added.id : undefined;
      }
      case "docker":
        return (
          (await vscode.commands.executeCommand<string | undefined>(
            "postgresql-workbench.startDockerDebugDatabase",
          )) ?? undefined
        );
      case "external":
        return this.importExternalConnection(picked.target.id, newExternal);
      case "connection":
        return (await this.connections.connectConnection(picked.target.id))
          ? picked.target.id
          : undefined;
    }
  }

  async editConnection(id: string, options: { connect?: boolean } = {}): Promise<void> {
    const connection = this.connections.store.get(id);
    if (!connection) return;
    const wasConnected = this.connections.isConnectionConnected(id);
    const edit = await promptConnectionEdit(connection);
    if (!edit) return;
    const updated = editedConnection(connection, edit);
    if (!updated) return;

    const changesDatabaseIdentity = !sameConnectionIdentity(connection, updated);
    if (changesDatabaseIdentity) {
      if (
        (wasConnected || options.connect) &&
        (await this.replaceConnection(connection, updated))
      ) {
        await this.connections.connectConnection(updated.id);
      } else if (!wasConnected && !options.connect) {
        await this.replaceConnection(connection, updated);
      }
      return;
    }

    await this.connections.store.update(
      id,
      updated,
      edit.key === "password" ? edit.value : undefined,
    );
    if (this.connections.isConnectionConnected(id)) {
      if (!(await this.connections.disconnect(id))) return;
      await this.connections.connectConnection(updated.id);
    } else {
      this.connections.notifyConfigurationChanged(id);
    }
  }

  async changePassword(id: string): Promise<void> {
    const connection = this.connections.store.get(id);
    if (!connection) return;
    const password = await vscode.window.showInputBox({
      prompt: `New password for ${getConnectionName(connection)}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;
    await this.connections.store.setPassword(id, password);
    void vscode.window.showInformationMessage(
      `Password updated for ${getConnectionName(connection)}.`,
    );
    if (this.connections.isConnectionConnected(id)) {
      const action = await vscode.window.showInformationMessage(
        "Reconnect with new password?",
        "Reconnect",
        "Later",
      );
      if (action === "Reconnect") {
        await this.connections.connectConnection(id, { force: true });
      }
    }
  }

  async renameConnection(id: string): Promise<void> {
    const connection = this.connections.store.get(id);
    if (!connection) return;
    const name = await vscode.window.showInputBox({
      prompt: "Connection name — leave empty to use its URL",
      placeHolder: getConnectionName({ ...connection, name: undefined }),
      value: getCustomConnectionName(connection) ?? "",
      ignoreFocusOut: true,
      validateInput: (candidate) => {
        const trimmed = candidate.trim();
        return !trimmed || this.connections.store.isConnectionNameAvailable(trimmed, id)
          ? undefined
          : `A Connection named "${trimmed}" already exists.`;
      },
    });
    if (name === undefined) return;
    await this.connections.store.update(id, { ...connection, name: name.trim() || undefined });
    this.connections.notifyConfigurationChanged(id);
  }

  private async importExternalConnection(
    id: string,
    connections: readonly ExternalConnection[],
  ): Promise<string | undefined> {
    const external = connections.find((connection) => connection.id === id);
    if (!external) return undefined;
    const connection: ConnectionConfig = {
      id: external.id,
      name: external.name,
      host: external.host,
      port: external.port,
      database: external.database,
      user: external.user,
    };
    await this.connections.store.add(connection, external.password);
    this.connections.notifyConfigurationChanged();
    return (await this.connections.connectConnection(external.id)) ? external.id : undefined;
  }

  private async replaceConnection(
    connection: ConnectionConfig,
    updated: ConnectionConfig,
  ): Promise<boolean> {
    if (this.connections.store.has(updated.id)) {
      void vscode.window.showWarningMessage(
        `${getConnectionName(updated)} already exists. Change each Scratchpad Association explicitly instead of replacing it.`,
      );
      return false;
    }
    if (
      !this.connections.store.isConnectionNameAvailable(getConnectionName(updated), connection.id)
    ) {
      void vscode.window.showWarningMessage(
        `A Connection named "${getConnectionName(updated)}" already exists. Rename it first.`,
      );
      return false;
    }
    if (
      !(await this.connections.replaceConnectionConfiguration(
        connection.id,
        updated,
        await this.connections.getPassword(connection.id),
      ))
    ) {
      return false;
    }
    void vscode.window.showInformationMessage(
      `Created ${getConnectionName(updated)} as a new Connection. Scratchpad Associations to ${getConnectionName(connection)} are now unavailable until explicitly changed.`,
    );
    return true;
  }
}

interface ConnectionInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: import("../../../packages/catalog/src/savedConnection.js").SslMode;
}

type ConnectionEditKey = "host" | "port" | "database" | "user" | "password" | "ssl";

interface ConnectionEdit {
  key: ConnectionEditKey;
  value: string;
}

async function promptConnection(input: string): Promise<ConnectionInput | undefined> {
  const parsed = parseConnectionString(input);
  if (parsed) {
    if (parsed.password) return parsed;
    const password = await vscode.window.showInputBox({
      prompt: "Password",
      password: true,
      ignoreFocusOut: true,
    });
    return password === undefined ? undefined : { ...parsed, password };
  }

  const [host, portText] = input.includes(":") ? input.split(":") : [input, "5432"];
  const parsedPort = parsePort(portText);
  if (parsedPort === undefined) {
    void vscode.window.showWarningMessage(`Invalid port "${portText}", using default 5432.`);
  }
  const database = await requiredInput("Database", "postgres");
  if (database === undefined) return undefined;
  const user = await requiredInput("User", "postgres");
  if (user === undefined) return undefined;
  const password = await vscode.window.showInputBox({
    prompt: "Password",
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return undefined;
  const ssl = await pickSslMode();
  if (!ssl) return undefined;
  return {
    host,
    port: parsedPort ?? 5432,
    database,
    user,
    password,
    ssl: ssl === "disable" ? undefined : ssl,
  };
}

async function requiredInput(prompt: string, value: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (candidate) => (candidate.trim() ? undefined : `${prompt} is required`),
  });
  return input?.trim();
}

async function promptConnectionEdit(
  connection: ConnectionConfig,
): Promise<ConnectionEdit | undefined> {
  const fields: Array<{ label: string; key: ConnectionEditKey; value: string }> = [
    { label: "Host", key: "host", value: connection.host },
    { label: "Port", key: "port", value: String(connection.port) },
    { label: "Database", key: "database", value: connection.database },
    { label: "User", key: "user", value: connection.user },
    { label: "Password", key: "password", value: "••••••••" },
    { label: "SSL", key: "ssl", value: connection.ssl ?? "disable" },
  ];
  const picked = await vscode.window.showQuickPick(
    fields.map((field) => ({
      label: field.label,
      description: field.value,
      detail: field.key,
    })),
    { placeHolder: `Edit ${getConnectionName(connection)} — pick a field to change` },
  );
  if (!picked?.detail) return undefined;
  const key = picked.detail as ConnectionEditKey;
  const value =
    key === "ssl"
      ? await pickSslMode()
      : await vscode.window.showInputBox({
          prompt: key === "password" ? "New password" : `New ${picked.label}`,
          value: key === "password" ? undefined : picked.description,
          password: key === "password",
          ignoreFocusOut: true,
        });
  return value === undefined ? undefined : { key, value };
}

function editedConnection(
  connection: ConnectionConfig,
  edit: ConnectionEdit,
): ConnectionConfig | undefined {
  const host = edit.key === "host" ? edit.value : connection.host;
  let port = connection.port;
  if (edit.key === "port") {
    const parsedPort = parsePort(edit.value);
    if (parsedPort === undefined) {
      void vscode.window.showWarningMessage(
        `Invalid port "${edit.value}" — keeping ${connection.port}.`,
      );
      return connection;
    }
    port = parsedPort;
  }
  const database = edit.key === "database" ? edit.value : connection.database;
  const user = edit.key === "user" ? edit.value : connection.user;
  const ssl =
    edit.key === "ssl"
      ? edit.value === "disable"
        ? undefined
        : (edit.value as import("../../../packages/catalog/src/savedConnection.js").SslMode)
      : connection.ssl;
  return {
    id: ConnectionStore.makeId(host, port, database, user),
    name: getCustomConnectionName(connection),
    host,
    port,
    database,
    user,
    ssl,
    ...(connection.tuning ? { tuning: connection.tuning } : {}),
    schemaSync: connection.schemaSync,
  };
}

function parsePort(raw: string): number | undefined {
  const port = Number.parseInt(raw, 10);
  return Number.isNaN(port) || port < 1 || port > 65535 ? undefined : port;
}

async function pickSslMode(): Promise<
  "disable" | import("../../../packages/catalog/src/savedConnection.js").SslMode | undefined
> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "disable", description: "No SSL" },
      { label: "prefer", description: "Use SSL if available" },
      { label: "require", description: "Require SSL" },
    ],
    { placeHolder: "SSL mode", ignoreFocusOut: true },
  );
  return picked?.label as
    | "disable"
    | import("../../../packages/catalog/src/savedConnection.js").SslMode
    | undefined;
}

function parseConnectionString(input: string): ConnectionInput | undefined {
  if (!/^postgres(ql)?:\/\//i.test(input)) return undefined;
  try {
    const url = new URL(input);
    const sslMode = url.searchParams.get("sslmode");
    return {
      host: url.hostname || "localhost",
      port: url.port ? Number.parseInt(url.port, 10) : 5432,
      database: url.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(url.username) || "postgres",
      password: decodeURIComponent(url.password),
      ssl:
        sslMode === "allow" ||
        sslMode === "prefer" ||
        sslMode === "require" ||
        sslMode === "verify-ca" ||
        sslMode === "verify-full"
          ? sslMode
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface ExternalConnection extends ConnectionInput {
  id: string;
  name: string;
}

type ConnectionQuickPickTarget =
  | { kind: "connection"; id: string }
  | { kind: "external"; id: string }
  | { kind: "docker" }
  | { kind: "add" };

interface ConnectionQuickPickItem extends vscode.QuickPickItem {
  target?: ConnectionQuickPickTarget;
}

function connectionQuickPickItems(
  connections: ConnectionManager,
  external: readonly ExternalConnection[],
): ConnectionQuickPickItem[] {
  const items: ConnectionQuickPickItem[] = connections.connections.map((connection) => {
    const connected = connections.isConnectionConnected(connection.id);
    return {
      label: `${connected ? "$(pass-filled) " : "$(circle-outline) "}${getConnectionName(connection)}`,
      description: connected ? "Connected" : "",
      target: { kind: "connection", id: connection.id },
    };
  });
  if (external.length > 0) {
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push(
      ...external.map((connection) => ({
        label: `$(extensions) ${connection.name}`,
        description: connection.id,
        target: { kind: "external" as const, id: connection.id },
      })),
    );
  }
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(vm-running) Start local debug database (Docker)...",
      description: "PostgreSQL 13–18 with pldebugger",
      target: { kind: "docker" },
    },
    { label: "$(add) Add connection...", target: { kind: "add" } },
  );
  return items;
}

export function loadSqlToolsConnections(): ExternalConnection[] {
  const config = vscode.workspace.getConfiguration("sqltools");
  const raw: {
    name?: string;
    server?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    driver?: string;
  }[] = config.get("connections") ?? [];
  return raw
    .filter((connection) => (connection.driver ?? "").toLowerCase().includes("postgres"))
    .map((connection) => {
      const host = connection.server ?? connection.host ?? "localhost";
      const port = connection.port ?? 5432;
      const database = connection.database ?? "postgres";
      const user = connection.username ?? "postgres";
      return {
        id: ConnectionStore.makeId(host, port, database, user),
        name: `${connection.name ?? host} (SQLTools)`,
        host,
        port,
        database,
        user,
        password: "",
      };
    });
}

export function loadPgsqlConnections(): ExternalConnection[] {
  const config = vscode.workspace.getConfiguration("pgsql");
  const raw: {
    server?: string;
    host?: string;
    hostaddr?: string;
    port?: number | string;
    database?: string;
    dbname?: string;
    user?: string;
    password?: string;
    displayName?: string;
    profileName?: string;
  }[] = config.get("connections") ?? [];
  return raw.map((connection) => {
    const host = connection.hostaddr ?? connection.server ?? connection.host ?? "localhost";
    const port =
      typeof connection.port === "string"
        ? Number.parseInt(connection.port, 10) || 5432
        : (connection.port ?? 5432);
    const database = connection.database ?? connection.dbname ?? "postgres";
    const user = connection.user ?? "postgres";
    return {
      id: ConnectionStore.makeId(host, port, database, user),
      name: `${connection.displayName ?? connection.profileName ?? host} (pgsql)`,
      host,
      port,
      database,
      user,
      password: connection.password ?? "",
    };
  });
}
