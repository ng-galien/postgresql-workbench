/**
 * A saved Connection: the endpoint the user registered, how it is named on screen, and what makes
 * two entries the same database. Storing the entries and their passwords is the Extension Host's
 * business, not this file's.
 */

/**
 * A saved server entry (no password — stored separately in secrets).
 */
export type SslMode = "disable" | "prefer" | "require";

export interface ServerConfig {
  /** Unique key: "host:port/database:user" */
  id: string;
  /** Optional unique user-facing name. The canonical URL is used when absent. */
  name?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: SslMode;
  /** Optional per-Connexion overrides for Workbench schema synchronization. */
  schemaSync?: {
    enabled?: boolean;
    supportSchema?: string;
  };
}

type ConnectionUrlIdentity = Pick<ServerConfig, "host" | "port" | "database" | "user">;

export function getConnectionUrl(server: ConnectionUrlIdentity): string {
  return `${server.user}@${server.host}:${server.port}/${server.database}`;
}

export function getCustomConnectionName(server: ServerConfig): string | undefined {
  const name = server.name?.trim();
  return name && name !== getConnectionUrl(server) ? name : undefined;
}

export function getConnectionName(server: ServerConfig): string {
  return getCustomConnectionName(server) ?? getConnectionUrl(server);
}

export function sameConnectionIdentity(
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
