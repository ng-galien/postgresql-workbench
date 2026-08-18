import * as vscode from "vscode";
import type { ConnectionManager } from "./connectionManager.js";
import {
  getConnectionName,
  getCustomConnectionName,
  type ServerConfig,
  ServerStore,
  sameConnectionIdentity,
} from "./serverStore.js";

export class ConnectionCommands {
  constructor(private readonly connections: ConnectionManager) {}

  async addServer(): Promise<ServerConfig | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: "Connection string or Host:Port",
      placeHolder: "postgresql://user:pass@localhost:5432/db  or  localhost:5432",
      value: "localhost:5432",
      ignoreFocusOut: true,
    });
    if (!input) return undefined;

    const connection = await promptConnection(input);
    if (!connection) return undefined;
    const id = ServerStore.makeId(
      connection.host,
      connection.port,
      connection.database,
      connection.user,
    );
    if (this.connections.store.has(id)) {
      const action = await vscode.window.showInformationMessage(
        "This server already exists.",
        "Connect",
      );
      if (action === "Connect") await this.connections.connectServer(id);
      return this.connections.store.get(id);
    }

    const server: ServerConfig = {
      id,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      ssl: connection.ssl,
    };
    await this.connections.store.add(server, connection.password);
    this.connections.notifyConfigurationChanged();
    await this.connections.connectServer(id);
    return server;
  }

  async removeServer(id: string): Promise<void> {
    const server = this.connections.store.get(id);
    if (!server) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove server "${getConnectionName(server)}"? Its saved password will be deleted.`,
      { modal: true },
      "Remove",
    );
    if (confirm !== "Remove") return;
    await this.connections.removeConnectionConfiguration(id);
  }

  /** Picks, imports, or creates a Connexion and returns the connected server id. */
  async pickConnection(): Promise<string | undefined> {
    const external = [...loadSqlToolsConnections(), ...loadPgsqlConnections()];
    const newExternal = external.filter((connection) => !this.connections.store.has(connection.id));
    const items = connectionQuickPickItems(this.connections, newExternal);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a PostgreSQL server",
    });
    if (!picked?.target) return undefined;
    switch (picked.target.kind) {
      case "add":
        return (await this.addServer())?.id;
      case "docker":
        return (
          (await vscode.commands.executeCommand<string | undefined>(
            "postgresql-workbench.startDockerDebugDatabase",
          )) ?? undefined
        );
      case "external":
        return this.importExternalConnection(picked.target.id, newExternal);
      case "server":
        return (await this.connections.connectServer(picked.target.id))
          ? picked.target.id
          : undefined;
    }
  }

  async editServer(id: string): Promise<void> {
    const server = this.connections.store.get(id);
    if (!server) return;
    const edit = await promptServerEdit(server);
    if (!edit) return;
    const updated = editedServer(server, edit);
    if (!updated) return;

    const changesDatabaseIdentity = !sameConnectionIdentity(server, updated);
    if (changesDatabaseIdentity) {
      await this.replaceConnexion(server, updated);
      return;
    }

    await this.connections.store.update(
      id,
      updated,
      edit.key === "password" ? edit.value : undefined,
    );
    if (this.connections.isServerConnected(id)) {
      if (!(await this.connections.disconnect(id))) return;
      await this.connections.connectServer(updated.id);
    } else {
      this.connections.notifyConfigurationChanged(id);
    }
  }

  async changePassword(id: string): Promise<void> {
    const server = this.connections.store.get(id);
    if (!server) return;
    const password = await vscode.window.showInputBox({
      prompt: `New password for ${getConnectionName(server)}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;
    await this.connections.store.setPassword(id, password);
    void vscode.window.showInformationMessage(`Password updated for ${getConnectionName(server)}.`);
    if (this.connections.isServerConnected(id)) {
      const action = await vscode.window.showInformationMessage(
        "Reconnect with new password?",
        "Reconnect",
        "Later",
      );
      if (action === "Reconnect") {
        await this.connections.connectServer(id, { force: true });
      }
    }
  }

  async renameServer(id: string): Promise<void> {
    const server = this.connections.store.get(id);
    if (!server) return;
    const name = await vscode.window.showInputBox({
      prompt: "Connexion name — leave empty to use its URL",
      placeHolder: getConnectionName({ ...server, name: undefined }),
      value: getCustomConnectionName(server) ?? "",
      ignoreFocusOut: true,
      validateInput: (candidate) => {
        const trimmed = candidate.trim();
        return !trimmed || this.connections.store.isConnectionNameAvailable(trimmed, id)
          ? undefined
          : `A Connexion named "${trimmed}" already exists.`;
      },
    });
    if (name === undefined) return;
    await this.connections.store.update(id, { ...server, name: name.trim() || undefined });
    this.connections.notifyConfigurationChanged(id);
  }

  private async importExternalConnection(
    id: string,
    connections: readonly ExternalConnection[],
  ): Promise<string | undefined> {
    const external = connections.find((connection) => connection.id === id);
    if (!external) return undefined;
    const server: ServerConfig = {
      id: external.id,
      name: external.name,
      host: external.host,
      port: external.port,
      database: external.database,
      user: external.user,
    };
    await this.connections.store.add(server, external.password);
    this.connections.notifyConfigurationChanged();
    return (await this.connections.connectServer(external.id)) ? external.id : undefined;
  }

  private async replaceConnexion(server: ServerConfig, updated: ServerConfig): Promise<void> {
    if (this.connections.store.has(updated.id)) {
      void vscode.window.showWarningMessage(
        `${getConnectionName(updated)} already exists. Change each Scratchpad Association explicitly instead of replacing it.`,
      );
      return;
    }
    if (!this.connections.store.isConnectionNameAvailable(getConnectionName(updated), server.id)) {
      void vscode.window.showWarningMessage(
        `A Connexion named "${getConnectionName(updated)}" already exists. Rename it first.`,
      );
      return;
    }
    if (
      !(await this.connections.replaceConnectionConfiguration(
        server.id,
        updated,
        await this.connections.getPassword(server.id),
      ))
    ) {
      return;
    }
    void vscode.window.showInformationMessage(
      `Created ${getConnectionName(updated)} as a new Connexion. Scratchpad Associations to ${getConnectionName(server)} are now unavailable until explicitly changed.`,
    );
  }
}

interface ConnectionInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: import("./serverStore.js").SslMode;
}

type ServerEditKey = "host" | "port" | "database" | "user" | "password" | "ssl";

interface ServerEdit {
  key: ServerEditKey;
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

async function promptServerEdit(server: ServerConfig): Promise<ServerEdit | undefined> {
  const fields: Array<{ label: string; key: ServerEditKey; value: string }> = [
    { label: "Host", key: "host", value: server.host },
    { label: "Port", key: "port", value: String(server.port) },
    { label: "Database", key: "database", value: server.database },
    { label: "User", key: "user", value: server.user },
    { label: "Password", key: "password", value: "••••••••" },
    { label: "SSL", key: "ssl", value: server.ssl ?? "disable" },
  ];
  const picked = await vscode.window.showQuickPick(
    fields.map((field) => ({
      label: field.label,
      description: field.value,
      detail: field.key,
    })),
    { placeHolder: `Edit ${getConnectionName(server)} — pick a field to change` },
  );
  if (!picked?.detail) return undefined;
  const key = picked.detail as ServerEditKey;
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

function editedServer(server: ServerConfig, edit: ServerEdit): ServerConfig | undefined {
  const host = edit.key === "host" ? edit.value : server.host;
  let port = server.port;
  if (edit.key === "port") {
    const parsedPort = parsePort(edit.value);
    if (parsedPort === undefined) {
      void vscode.window.showWarningMessage(
        `Invalid port "${edit.value}" — keeping ${server.port}.`,
      );
      return server;
    }
    port = parsedPort;
  }
  const database = edit.key === "database" ? edit.value : server.database;
  const user = edit.key === "user" ? edit.value : server.user;
  const ssl =
    edit.key === "ssl"
      ? edit.value === "disable"
        ? undefined
        : (edit.value as import("./serverStore.js").SslMode)
      : server.ssl;
  return {
    id: ServerStore.makeId(host, port, database, user),
    name: getCustomConnectionName(server),
    host,
    port,
    database,
    user,
    ssl,
    schemaSync: server.schemaSync,
  };
}

function parsePort(raw: string): number | undefined {
  const port = Number.parseInt(raw, 10);
  return Number.isNaN(port) || port < 1 || port > 65535 ? undefined : port;
}

async function pickSslMode(): Promise<"disable" | import("./serverStore.js").SslMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "disable", description: "No SSL" },
      { label: "prefer", description: "Use SSL if available" },
      { label: "require", description: "Require SSL" },
    ],
    { placeHolder: "SSL mode", ignoreFocusOut: true },
  );
  return picked?.label as "disable" | import("./serverStore.js").SslMode | undefined;
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
      ssl: sslMode === "require" ? "require" : sslMode === "prefer" ? "prefer" : undefined,
    };
  } catch {
    return undefined;
  }
}

interface ExternalConnection extends ConnectionInput {
  id: string;
  name: string;
}

type ConnectionQuickPickTarget =
  | { kind: "server"; id: string }
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
  const items: ConnectionQuickPickItem[] = connections.servers.map((server) => {
    const connected = connections.isServerConnected(server.id);
    return {
      label: `${connected ? "$(pass-filled) " : "$(circle-outline) "}${getConnectionName(server)}`,
      description: connected ? "Connected" : "",
      target: { kind: "server", id: server.id },
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
    { label: "$(add) Add server...", target: { kind: "add" } },
  );
  return items;
}

function loadSqlToolsConnections(): ExternalConnection[] {
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
        id: ServerStore.makeId(host, port, database, user),
        name: `${connection.name ?? host} (SQLTools)`,
        host,
        port,
        database,
        user,
        password: "",
      };
    });
}

function loadPgsqlConnections(): ExternalConnection[] {
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
      id: ServerStore.makeId(host, port, database, user),
      name: `${connection.displayName ?? connection.profileName ?? host} (pgsql)`,
      host,
      port,
      database,
      user,
      password: connection.password ?? "",
    };
  });
}
