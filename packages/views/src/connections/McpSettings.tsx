import { useEffect, useState } from "react";
import type { ConnectionSummary, ConnectionsPageRequest, McpSettingsState } from "./protocol.js";

export function McpSettings({
  state,
  connections,
  post,
}: {
  state?: McpSettingsState;
  connections: ConnectionSummary[];
  post(message: ConnectionsPageRequest): void;
}) {
  const [port, setPort] = useState(String(state?.port ?? 7432));
  const [connectionId, setConnectionId] = useState("");
  const savedPort = state?.port;
  useEffect(() => {
    if (savedPort !== undefined) setPort(String(savedPort));
  }, [savedPort]);
  if (!state) return <p>Loading MCP settings…</p>;
  const blocked = state.busy || !state.trusted || !state.project;
  const running = state.status === "Running" || state.status === "Starting";
  return (
    <section aria-label="MCP server" className="connections-app-settings">
      <header>
        <h3>MCP server</h3>
        <p>Give local agents their own Workbench sessions, results, debugger and coverage.</p>
      </header>
      <p role="status">
        {state.status}
        {state.pid ? ` · PID ${state.pid}` : ""}
      </p>
      <p>
        <code>{state.url}</code>
      </p>
      {state.activeConnection && <p>Available Connection: {state.activeConnection}</p>}
      {state.message && <p role="alert">{state.message}</p>}
      {!state.project && <p>Open one local project folder to manage MCP integrations.</p>}
      {!state.trusted && (
        <p>Trust this workspace in VS Code before starting MCP or installing configurations.</p>
      )}
      <label>
        <span>MCP port</span>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          disabled={blocked || running}
          onChange={(event) => setPort(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={blocked || running || Number(port) === state.port}
        onClick={() => post({ type: "mcpAction", action: "port", port: Number(port) })}
      >
        Apply port
      </button>
      <label>
        <span>Connection available to agents</span>
        <select
          value={connectionId}
          disabled={blocked || running}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          <option value="">Choose a saved Connection</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name ??
                `${connection.user}@${connection.host}:${connection.port}/${connection.database}`}
            </option>
          ))}
        </select>
      </label>
      <p>
        Starting grants MCP clients access to this Connection, including SQL writes. Stop and start
        again to apply saved Connection changes. Stopping discards the server’s sessions and
        retained observations. Idle client sessions expire after 30 minutes.
      </p>
      <button
        type="button"
        disabled={blocked || running || !connectionId}
        onClick={() => post({ type: "mcpAction", action: "start", connectionId })}
      >
        Start MCP server
      </button>
      <button
        type="button"
        disabled={state.busy || !running}
        onClick={() => post({ type: "mcpAction", action: "stop" })}
      >
        Stop MCP server
      </button>
      <button
        type="button"
        disabled={state.busy}
        onClick={() => post({ type: "mcpAction", action: "refresh" })}
      >
        Refresh MCP status
      </button>
      <h4>Project integrations</h4>
      <p>{state.project}</p>
      <p>
        Configurations contain a private local access token. Installation excludes them from Git.
        Restart or reconnect the client after installing; approve the server in Codex or Claude
        Code. Client policies and active connections are not checked here.
      </p>
      {state.integrations.map((integration) => (
        <section
          key={integration.client}
          aria-label={
            integration.client === "codex" ? "Codex integration" : "Claude Code integration"
          }
        >
          <h4>{integration.client === "codex" ? "Codex" : "Claude Code"}</h4>
          <p>{integration.status}</p>
          <p>
            <code>{integration.path}</code>
          </p>
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              post({ type: "mcpAction", action: "install", client: integration.client })
            }
          >
            Install / update {integration.client === "codex" ? "Codex" : "Claude Code"}
          </button>
        </section>
      ))}
      <p>
        This server is local to the extension host machine and stops when its VS Code window closes.
        The standalone launcher can also run it without VS Code.
      </p>
    </section>
  );
}
