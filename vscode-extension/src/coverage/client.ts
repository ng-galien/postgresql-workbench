import { Client } from "pg";
import { getConnectionName } from "../../../packages/catalog/src/savedConnection.js";
import type { ConnectionManager } from "../connection/index.js";

export async function openCoverageClient(
  connections: ConnectionManager,
  connectionId: string,
  options: {
    applicationName?: string;
    statementTimeoutMs?: number;
  } = {},
): Promise<Client> {
  const connection = connections.store.get(connectionId);
  if (!connection)
    throw new Error(`PostgreSQL connection ${connectionId} is no longer configured.`);
  const password = await connections.store.getPassword(connectionId);
  if (password === undefined) {
    throw new Error(
      `PostgreSQL connection ${getConnectionName(connection)} has no saved password.`,
    );
  }
  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 60_000,
    application_name: options.applicationName ?? "postgresql-workbench:test-runner",
    ...(connection.ssl === "require" || connection.ssl === "prefer"
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });
  await client.connect();
  return client;
}
