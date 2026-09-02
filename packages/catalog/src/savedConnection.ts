/**
 * A saved Connection: the endpoint the user registered, how it is named on screen, and what makes
 * two entries the same database. Storing the entries and their passwords is the Extension Host's
 * business, not this file's.
 */

/**
 * A saved connection entry (no password — stored separately in secrets).
 */
export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

/**
 * How the client opens its sessions, beyond the endpoint identity: TLS material, timeouts, the
 * session identity and settings PostgreSQL applies at startup. Everything optional — an absent
 * value means the Workbench default for that lane.
 */
export interface ConnectionTuning {
  /** PEM files the host reads at connect time; paths, never contents. */
  sslRootCert?: string;
  sslCert?: string;
  sslKey?: string;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  keepAlive?: boolean;
  /** Overrides the per-lane application_name this Workbench reports to PostgreSQL. */
  applicationName?: string;
  searchPath?: string;
  /** Extra server settings in libpq `options` syntax: `-c work_mem=64MB -c timezone=UTC`. */
  serverOptions?: string;
  /** Opens every session with default_transaction_read_only = on. */
  readOnly?: boolean;
}

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
  tuning?: ConnectionTuning;
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
