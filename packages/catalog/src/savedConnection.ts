/**
 * A saved Connection: the endpoint the user registered, how it is named on screen, and what makes
 * two entries the same database. Storing the entries and their passwords is the Extension Host's
 * business, not this file's.
 */

/**
 * A saved connection entry (no password — stored separately in secrets).
 */
export type SslMode = "disable" | "prefer" | "require";

export interface ConnectionConfig {
  /** Unique key: "host:port/database:user" */
  id: string;
  /** Optional unique user-facing name. The canonical URL is used when absent. */
  name?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: SslMode;
  /** Optional per-Connection overrides for Workbench schema synchronization. */
  schemaSync?: {
    enabled?: boolean;
    supportSchema?: string;
  };
}

type ConnectionUrlIdentity = Pick<ConnectionConfig, "host" | "port" | "database" | "user">;

export function getConnectionUrl(connection: ConnectionUrlIdentity): string {
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

export function getCustomConnectionName(connection: ConnectionConfig): string | undefined {
  const name = connection.name?.trim();
  return name && name !== getConnectionUrl(connection) ? name : undefined;
}

export function getConnectionName(connection: ConnectionConfig): string {
  return getCustomConnectionName(connection) ?? getConnectionUrl(connection);
}

export function sameConnectionIdentity(
  left: Pick<ConnectionConfig, "host" | "port" | "database" | "user">,
  right: Pick<ConnectionConfig, "host" | "port" | "database" | "user">,
): boolean {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.user === right.user
  );
}
