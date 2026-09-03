import { useState } from "react";
import type {
  PostgresServerDatabase,
  PostgresServerExtension,
  PostgresServerSession,
  PostgresServerSnapshot,
} from "../../../catalog/src/serverSnapshot.js";
import { formatBytes, formatSince, postgresVersionHeadline } from "./format.js";
import type { WorkbenchServerExtension } from "./protocol.js";

const WORKBENCH_EXTENSIONS: Record<WorkbenchServerExtension, string> = {
  pldbgapi: "Required by the PL/pgSQL debugger.",
  pgtap: "Required by pgTAP testing and coverage.",
};

function installableExtension(name: string): WorkbenchServerExtension | undefined {
  return name === "pldbgapi" || name === "pgtap" ? name : undefined;
}

/** Live operational state for the selected PostgreSQL server. */
export function ServerPanel({
  server,
  installing,
  onInstallExtension,
  onStartDockerDatabase,
  onLiveHold,
}: {
  server: PostgresServerSnapshot;
  installing?: WorkbenchServerExtension;
  onInstallExtension: (name: WorkbenchServerExtension) => void;
  onStartDockerDatabase: () => void;
  /** A reader is inside a session detail: live refreshes would move the text under them. */
  onLiveHold?: (held: boolean) => void;
}) {
  const [expandedSession, setExpandedSession] = useState<number | undefined>(undefined);
  const largestDatabase = Math.max(...server.databases.map((entry) => entry.sizeBytes ?? 0), 1);
  const connectionLoad = server.currentConnections / Math.max(1, server.maxConnections);
  return (
    <div className="connections-server">
      <section aria-label="Server overview" className="connections-overview">
        <div className="connections-server-identity">
          <span className="connections-server-mark">PG</span>
          <div>
            <h4>{postgresVersionHeadline(server.version)}</h4>
            <p title={server.version}>{server.version}</p>
          </div>
        </div>
        <dl className="connections-facts">
          <div>
            <dt>Uptime</dt>
            <dd>{formatSince(server.startedAt)}</dd>
          </div>
          <div>
            <dt>Encoding</dt>
            <dd>{server.encoding}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{server.timeZone}</dd>
          </div>
          <div>
            <dt>Connections</dt>
            <dd>
              {server.currentConnections} / {server.maxConnections}
            </dd>
          </div>
        </dl>
        <div
          aria-label={`${server.currentConnections} of ${server.maxConnections} connections in use`}
          className="connections-gauge"
          role="img"
        >
          <div
            className={`connections-gauge-fill ${
              connectionLoad >= 0.9
                ? "connections-gauge-critical"
                : connectionLoad >= 0.7
                  ? "connections-gauge-warning"
                  : ""
            }`}
            style={{ width: `${Math.min(100, connectionLoad * 100)}%` }}
          />
        </div>
      </section>

      <section
        aria-label="Open sessions"
        className="connections-diagnostic-section connections-sessions-panel"
      >
        <details open>
          <summary>
            <span>Sessions</span>
            <span className="connections-count">{server.sessions.length} open</span>
          </summary>
          <div className="connections-table-scroll">
            <table className="connections-sessions">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>User</th>
                  <th>Database</th>
                  <th>Application</th>
                  <th>State</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {server.sessions.map((session) => (
                  <SessionRow
                    expanded={expandedSession === session.pid}
                    key={session.pid}
                    onToggle={() => {
                      const next = expandedSession === session.pid ? undefined : session.pid;
                      setExpandedSession(next);
                      onLiveHold?.(next !== undefined);
                    }}
                    session={session}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section
        aria-label="Extensions"
        className="connections-diagnostic-section connections-capabilities-panel"
      >
        <details open>
          <summary>
            <span>Capabilities</span>
            <span className="connections-count">
              {server.extensions.filter((extension) => extension.installedVersion).length}{" "}
              extensions
            </span>
          </summary>
          <ul className="connections-extensions">
            {server.extensions.map((extension) => (
              <ExtensionRow
                extension={extension}
                installing={installing}
                key={extension.name}
                onInstall={onInstallExtension}
                onStartDockerDatabase={onStartDockerDatabase}
              />
            ))}
          </ul>
        </details>
      </section>

      <section
        aria-label="Databases"
        className="connections-diagnostic-section connections-databases-panel"
      >
        <details open>
          <summary>
            <span>Databases</span>
            <span className="connections-count">{server.databases.length} available</span>
          </summary>
          <ul className="connections-databases">
            {server.databases.map((database) => (
              <DatabaseRow database={database} key={database.name} largest={largestDatabase} />
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}

function SessionRow({
  session,
  expanded,
  onToggle,
}: {
  session: PostgresServerSession;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={expanded ? "connections-session-expanded" : ""}>
        <td className="connections-mono">
          <button
            aria-expanded={expanded}
            className="connections-session-toggle"
            onClick={onToggle}
            title={`Show PostgreSQL session ${session.pid}`}
            type="button"
          >
            {session.pid}
          </button>
        </td>
        <td>{session.user ?? "—"}</td>
        <td>{session.database ?? "—"}</td>
        <td className="connections-mono">{session.applicationName || "—"}</td>
        <td>
          <span className={`connections-state connections-state-${stateClass(session.state)}`}>
            {session.state}
          </span>
        </td>
        <td>{formatSince(session.backendStart)}</td>
      </tr>
      {expanded ? (
        <tr className="connections-session-detail-row">
          <td colSpan={6}>
            <div className="connections-session-detail">
              <dl>
                <div>
                  <dt>Client</dt>
                  <dd>{session.clientAddress ?? "local"}</dd>
                </div>
                <div>
                  <dt>Backend started</dt>
                  <dd>{formatTimestamp(session.backendStart)}</dd>
                </div>
                <div>
                  <dt>Transaction started</dt>
                  <dd>
                    {session.transactionStart ? formatTimestamp(session.transactionStart) : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Query started</dt>
                  <dd>{session.queryStart ? formatTimestamp(session.queryStart) : "—"}</dd>
                </div>
                <div>
                  <dt>Wait event</dt>
                  <dd>
                    {[session.waitEventType, session.waitEvent].filter(Boolean).join(" · ") || "—"}
                  </dd>
                </div>
              </dl>
              <div className="connections-session-query">
                <span>Current / last query</span>
                <pre>{session.query?.trim() || "No query text available"}</pre>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function stateClass(state: string): string {
  if (state === "active") return "active";
  if (state.startsWith("idle in transaction")) return "transaction";
  if (state === "idle") return "idle";
  return "other";
}

function DatabaseRow({ database, largest }: { database: PostgresServerDatabase; largest: number }) {
  return (
    <li>
      <span className="connections-database-name">
        {database.name}
        {database.current ? <span className="connections-current-badge">current</span> : null}
      </span>
      <span className="connections-database-bar">
        <span
          className="connections-database-fill"
          style={{ width: `${((database.sizeBytes ?? 0) / largest) * 100}%` }}
        />
      </span>
      <span className="connections-database-size">
        {database.sizeBytes === undefined ? "—" : formatBytes(database.sizeBytes)}
      </span>
    </li>
  );
}

function ExtensionRow({
  extension,
  installing,
  onInstall,
  onStartDockerDatabase,
}: {
  extension: PostgresServerExtension;
  installing?: WorkbenchServerExtension;
  onInstall: (name: WorkbenchServerExtension) => void;
  onStartDockerDatabase: () => void;
}) {
  const workbenchUse = installableExtension(extension.name);
  const installed = Boolean(extension.installedVersion);
  const offered = Boolean(extension.defaultVersion);
  return (
    <li className={installed ? "" : "connections-extension-absent"}>
      <span className="connections-extension-name connections-mono">{extension.name}</span>
      <span className="connections-extension-status">
        {installed ? (
          <span className="connections-extension-installed">
            installed {extension.installedVersion}
          </span>
        ) : offered && workbenchUse ? (
          <button
            disabled={installing !== undefined}
            onClick={() => onInstall(workbenchUse)}
            type="button"
          >
            {installing === workbenchUse ? "Installing…" : `Install ${extension.name}`}
          </button>
        ) : (
          <span className="connections-extension-missing">not on this server</span>
        )}
      </span>
      <span className="connections-extension-comment">
        {workbenchUse ? WORKBENCH_EXTENSIONS[workbenchUse] : (extension.comment ?? "")}
        {!installed && !offered && workbenchUse === "pldbgapi" ? (
          <button className="connections-link" onClick={onStartDockerDatabase} type="button">
            Start a local debug database
          </button>
        ) : null}
      </span>
    </li>
  );
}
