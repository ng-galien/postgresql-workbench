import { Client } from "pg";
import type * as vscode from "vscode";
import {
  type PostgresClientIdentity,
  postgresClientConfig,
} from "../../../packages/catalog/src/postgresClientConfig.js";

export type ConnectionErrorKind = "auth" | "network" | "database" | "unknown";
export interface ConnectionError {
  message: string;
  kind: ConnectionErrorKind;
}

export type ConnectParams = PostgresClientIdentity;

/**
 * Handles pg.Client lifecycle and pldbgapi validation.
 * Stateless — does not store anything, just connects/checks/disconnects.
 */
export class ConnectionService {
  constructor(private readonly out: vscode.OutputChannel) {}

  async connectClient(params: ConnectParams): Promise<Client> {
    const client = new Client(postgresClientConfig(params));

    await client.connect();
    this.out.appendLine(`TCP connected to ${params.host}:${params.port}/${params.database}`);
    return client;
  }

  async disconnect(client: Client): Promise<void> {
    try {
      await client.end();
    } catch {
      return;
    }
  }

  async installPldbgapi(client: Client): Promise<boolean> {
    try {
      await client.query("CREATE EXTENSION pldbgapi");
      this.out.appendLine("pldbgapi extension installed.");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.out.appendLine(`Failed to install pldbgapi: ${msg}`);
      throw err;
    }
  }

  /**
   * Categorize a connection error into a user-friendly message.
   */
  describeError(err: unknown): string {
    return this.classifyError(err).message;
  }

  classifyError(err: unknown): ConnectionError {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("password authentication failed") ||
      msg.includes("no pg_hba.conf") ||
      msg.includes("password must be a string")
    ) {
      return { message: "Authentication failed. Check user/password.", kind: "auth" };
    }
    if (msg.includes("ECONNREFUSED")) {
      return { message: "Connection refused. Is PostgreSQL running?", kind: "network" };
    }
    if (msg.includes("ENOTFOUND")) {
      return { message: "Host not found. Check the hostname.", kind: "network" };
    }
    if (msg.includes("timeout")) {
      return { message: "Connection timed out. Check host, port, and firewall.", kind: "network" };
    }
    if (msg.includes("does not exist")) {
      return { message: "Database does not exist.", kind: "database" };
    }
    return { message: msg, kind: "unknown" };
  }

  /** Run the pldbgapi requirement checks on an established connection. */
  async checkRequirements(
    client: Client,
    database: string,
  ): Promise<{ available: boolean; error: string }> {
    try {
      const result = await client.query("SHOW shared_preload_libraries");
      const spl = (result.rows[0]?.shared_preload_libraries as string) ?? "";
      if (!spl.includes("plugin_debugger")) {
        const error =
          "plugin_debugger not in shared_preload_libraries. Add it to postgresql.conf and restart PostgreSQL.";
        this.out.appendLine(`shared_preload_libraries = "${spl}" — ${error}`);
        return { available: false, error };
      }
    } catch {}

    try {
      await client.query("SELECT * FROM pldbg_get_proxy_info()");
      this.out.appendLine(`pldbgapi available on "${database}".`);
      return { available: true, error: "" };
    } catch {
      const error = `pldbgapi extension not installed on "${database}".`;
      this.out.appendLine(error);
      return { available: false, error };
    }
  }
}
