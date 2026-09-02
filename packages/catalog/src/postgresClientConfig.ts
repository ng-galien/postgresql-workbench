import { readFileSync } from "node:fs";
import type { ConnectionTuning, SslMode } from "./savedConnection.js";

/**
 * The pg client options one endpoint identity and its tuning stand for. Every host — the VS Code
 * extension, the browser shell, Electron — composes its clients here, so an SslMode means the
 * same TLS everywhere. Certificate files are read at connect time, never stored.
 */
export interface PostgresClientIdentity {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: SslMode;
  tuning?: ConnectionTuning;
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function postgresClientConfig(params: PostgresClientIdentity): Record<string, unknown> {
  const tuning = params.tuning ?? {};
  const applicationName = tuning.applicationName ?? params.applicationName;
  const serverOptions = composeServerOptions(tuning);
  const ssl = sslClientConfig(params.ssl, tuning);
  return {
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password,
    connectionTimeoutMillis: tuning.connectTimeoutMs ?? 10_000,
    statement_timeout: params.statementTimeoutMs ?? tuning.statementTimeoutMs ?? 10_000,
    ...(applicationName ? { application_name: applicationName } : {}),
    ...(serverOptions ? { options: serverOptions } : {}),
    ...(tuning.keepAlive === undefined ? {} : { keepAlive: tuning.keepAlive }),
    ...(ssl ? { ssl } : {}),
  };
}

/** The startup settings a session carries, in libpq `options` syntax. */
function composeServerOptions(tuning: ConnectionTuning): string | undefined {
  const parts: string[] = [];
  if (tuning.searchPath) parts.push(`-c search_path=${tuning.searchPath}`);
  if (tuning.readOnly) parts.push("-c default_transaction_read_only=on");
  if (tuning.serverOptions) parts.push(tuning.serverOptions);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The TLS options one SslMode stands for. `allow`, `prefer` and `require` encrypt without
 * verifying the chain; `verify-ca` verifies the chain against the CA file; `verify-full` also
 * verifies the hostname. Certificate files are read here, at connect time, never stored.
 */
function sslClientConfig(
  mode: SslMode | undefined,
  tuning: ConnectionTuning,
): Record<string, unknown> | undefined {
  if (!mode || mode === "disable") return undefined;
  const material = {
    ...(tuning.sslRootCert ? { ca: readPemFile("CA certificate", tuning.sslRootCert) } : {}),
    ...(tuning.sslCert ? { cert: readPemFile("client certificate", tuning.sslCert) } : {}),
    ...(tuning.sslKey ? { key: readPemFile("client key", tuning.sslKey) } : {}),
  };
  if (mode === "verify-full") return { rejectUnauthorized: true, ...material };
  if (mode === "verify-ca") {
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined, ...material };
  }
  return { rejectUnauthorized: false, ...material };
}

function readPemFile(role: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the SSL ${role} at ${path}: ${detail}`);
  }
}
