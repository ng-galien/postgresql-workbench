import type { Client } from "pg";

/**
 * What one PostgreSQL server says about itself at a glance: its version and settings, who is
 * connected right now, and the databases it serves with their sizes. Read from the catalog in
 * three cheap queries — the Connections page shows this after every successful test.
 */
export interface PostgresServerSnapshot {
  version: string;
  startedAt: string;
  encoding: string;
  timeZone: string;
  maxConnections: number;
  currentConnections: number;
  sessions: PostgresServerSession[];
  databases: PostgresServerDatabase[];
  /** Installed extensions, plus the ones the Workbench builds on even when absent. */
  extensions: PostgresServerExtension[];
}

export interface PostgresServerSession {
  pid: number;
  user?: string;
  database?: string;
  applicationName: string;
  state: string;
  clientAddress?: string;
  backendStart: string;
  transactionStart?: string;
  queryStart?: string;
  waitEventType?: string;
  waitEvent?: string;
  query?: string;
}

export interface PostgresServerExtension {
  name: string;
  defaultVersion?: string;
  installedVersion?: string;
  comment?: string;
}

export interface PostgresServerDatabase {
  name: string;
  /** Absent when the tested role may not connect to the database, and so may not measure it. */
  sizeBytes?: number;
  current: boolean;
}

export async function readPostgresServerSnapshot(client: Client): Promise<PostgresServerSnapshot> {
  const [server, sessions, databases, extensions] = await Promise.all([
    client.query<{
      version: string;
      started_at: Date;
      encoding: string;
      timezone: string;
      max_connections: string;
    }>(
      `SELECT version() AS version,
              pg_postmaster_start_time() AS started_at,
              current_setting('server_encoding') AS encoding,
              current_setting('TimeZone') AS timezone,
              current_setting('max_connections') AS max_connections`,
    ),
    client.query<{
      pid: number;
      usename: string | null;
      datname: string | null;
      application_name: string;
      state: string | null;
      client_addr: string | null;
      backend_start: Date;
      xact_start: Date | null;
      query_start: Date | null;
      wait_event_type: string | null;
      wait_event: string | null;
      query: string;
    }>(
      `SELECT pid, usename, datname, application_name, state,
              client_addr::text AS client_addr, backend_start, xact_start, query_start,
              wait_event_type, wait_event, left(query, 500) AS query
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'
        ORDER BY backend_start
        LIMIT 100`,
    ),
    client.query<{ name: string; size_bytes: string | null; current: boolean }>(
      `SELECT datname AS name,
              CASE WHEN has_database_privilege(datname, 'CONNECT')
                   THEN pg_database_size(oid) END AS size_bytes,
              datname = current_database() AS current
         FROM pg_database
        WHERE datallowconn
        ORDER BY size_bytes DESC NULLS LAST, datname`,
    ),
    client.query<{
      name: string;
      default_version: string | null;
      installed_version: string | null;
      comment: string | null;
    }>(
      `SELECT name, default_version, installed_version, comment
         FROM pg_available_extensions
        WHERE installed_version IS NOT NULL OR name IN ('pldbgapi', 'pgtap')
        ORDER BY installed_version IS NULL, name`,
    ),
  ]);
  const facts = server.rows[0];
  if (!facts) throw new Error("PostgreSQL did not answer the server settings query.");
  return {
    version: facts.version,
    startedAt: facts.started_at.toISOString(),
    encoding: facts.encoding,
    timeZone: facts.timezone,
    maxConnections: Number(facts.max_connections),
    currentConnections: sessions.rows.length,
    sessions: sessions.rows.map((row) => ({
      pid: row.pid,
      ...(row.usename ? { user: row.usename } : {}),
      ...(row.datname ? { database: row.datname } : {}),
      applicationName: row.application_name,
      state: row.state ?? "unknown",
      ...(row.client_addr ? { clientAddress: row.client_addr } : {}),
      backendStart: row.backend_start.toISOString(),
      ...(row.xact_start ? { transactionStart: row.xact_start.toISOString() } : {}),
      ...(row.query_start ? { queryStart: row.query_start.toISOString() } : {}),
      ...(row.wait_event_type ? { waitEventType: row.wait_event_type } : {}),
      ...(row.wait_event ? { waitEvent: row.wait_event } : {}),
      ...(row.query ? { query: row.query } : {}),
    })),
    databases: databases.rows.map((row) => ({
      name: row.name,
      ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
      current: row.current,
    })),
    extensions: extensions.rows.map((row) => ({
      name: row.name,
      ...(row.default_version === null ? {} : { defaultVersion: row.default_version }),
      ...(row.installed_version === null ? {} : { installedVersion: row.installed_version }),
      ...(row.comment === null ? {} : { comment: row.comment }),
    })),
  };
}
