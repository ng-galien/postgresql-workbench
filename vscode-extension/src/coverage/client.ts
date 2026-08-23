import { Client } from "pg";
import { getConnectionName } from "../../../packages/catalog/src/savedConnection.js";
import type { ConnectionManager } from "../connection/index.js";

export async function openCoverageClient(
  connections: ConnectionManager,
  serverId: string,
  options: {
    applicationName?: string;
    statementTimeoutMs?: number;
  } = {},
): Promise<Client> {
  const server = connections.store.get(serverId);
  if (!server) throw new Error(`PostgreSQL connection ${serverId} is no longer configured.`);
  const password = await connections.store.getPassword(serverId);
  if (password === undefined) {
    throw new Error(`PostgreSQL connection ${getConnectionName(server)} has no saved password.`);
  }
  const client = new Client({
    host: server.host,
    port: server.port,
    database: server.database,
    user: server.user,
    password,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 60_000,
    application_name: options.applicationName ?? "postgresql-workbench:test-runner",
    ...(server.ssl === "require" || server.ssl === "prefer"
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });
  await client.connect();
  return client;
}
