import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { getConnectionName, getConnectionUrl } from "../../../catalog/src/savedConnection.js";
import type { PostgresServerSnapshot } from "../../../catalog/src/serverSnapshot.js";
import type { ViewMessaging } from "../messaging.js";
import { IndexPanel } from "./IndexPanel.js";
import {
  APP_SETTINGS,
  type AppSettingDescriptor,
  type AppSettingSection,
  type AppSettingValue,
  type ConnectionDraft,
  type ConnectionSummary,
  type ConnectionsPageRequest,
  type ConnectionsPageResponse,
  type ConnectionTestReport,
  type ConnectionTuning,
  type SslMode,
  type WorkbenchServerExtension,
} from "./protocol.js";
import { ServerPanel } from "./ServerPanel.js";

interface ContextMenuState {
  connectionId: string;
  left: number;
  top: number;
}

/** Saved endpoints on the left; lifecycle, settings and live state in one responsive workspace. */
export function ConnectionsApp({
  messaging,
}: {
  messaging: ViewMessaging<ConnectionsPageRequest, ConnectionsPageResponse>;
}) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dockerSetupOpen, setDockerSetupOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [activeAppSection, setActiveAppSection] = useState<AppSettingSection>("authoring");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<ConnectionTestReport>();
  const [transition, setTransition] = useState<{
    id: string;
    action: "connect" | "disconnect";
  }>();
  const [connectionError, setConnectionError] = useState<string>();
  const [inspection, setInspection] = useState<{
    id: string;
    server: PostgresServerSnapshot;
    capturedAt: number;
  }>();
  const [inspectionError, setInspectionError] = useState<string>();
  const [installing, setInstalling] = useState<WorkbenchServerExtension>();
  const [liveHold, setLiveHold] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("connection");
  const [appSettings, setAppSettings] = useState<Record<string, AppSettingValue>>({});
  const pickSequence = useRef(0);
  const [installError, setInstallError] = useState<string>();
  const [schemaSyncBusy, setSchemaSyncBusy] = useState(false);
  const [schemaSyncError, setSchemaSyncError] = useState<string>();
  const [confirmingProvision, setConfirmingProvision] = useState(false);
  const testSequence = useRef(0);
  const inspectionSequence = useRef(0);
  const handlers = useRef({
    applyCertificate: (_purpose: "ca" | "cert" | "key", _path: string) => {},
    afterExtensionInstalled: () => {},
  });
  const editorKeyRef = useRef<string | undefined>(undefined);
  const requestedSettingsRef = useRef<string | undefined>(undefined);

  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId),
    [connections, selectedId],
  );

  useEffect(() => {
    const unsubscribe = messaging.subscribe((message) => {
      if (message.type === "appSettings") {
        setAppSettings(message.values);
        return;
      }
      if (message.type === "state") {
        setConnections(message.connections);
        setSelectedId((current) =>
          current && message.connections.some((connection) => connection.id === current)
            ? current
            : message.connections[0]?.id,
        );
        return;
      }
      if (message.type === "saved") {
        setSelectedId(message.id);
        setAdding(false);
        setDirty(false);
        setSaveError(undefined);
        return;
      }
      if (message.type === "saveFailed") {
        setSaveError(message.message);
        return;
      }
      if (message.type === "connectionAction") {
        setTransition((current) => (current?.id === message.id ? undefined : current));
        setConnectionError(message.ok ? undefined : message.message);
        if (message.ok && message.action === "connect") setSettingsOpen(false);
        if (message.ok && message.action === "disconnect") {
          setInspection((current) => (current?.id === message.id ? undefined : current));
        }
        return;
      }
      if (message.type === "tested" && message.requestId === testSequence.current) {
        setTesting(false);
        setReport(message.report);
        return;
      }
      if (message.type === "inspected" && message.requestId === inspectionSequence.current) {
        setInspection({ id: message.id, server: message.server, capturedAt: Date.now() });
        setInspectionError(undefined);
        return;
      }
      if (message.type === "inspectionFailed" && message.requestId === inspectionSequence.current) {
        setInspectionError(message.message);
        return;
      }
      if (message.type === "schemaSyncAction") {
        setSchemaSyncBusy(false);
        setSchemaSyncError(message.ok ? undefined : message.message);
        if (message.ok) setConfirmingProvision(false);
        return;
      }
      if (message.type === "dockerDatabaseStarted") {
        if (message.id) {
          setDockerSetupOpen(false);
          setSelectedId(message.id);
        }
        return;
      }
      if (message.type === "certificatePicked") {
        if (message.requestId === pickSequence.current && message.path) {
          handlers.current.applyCertificate(message.purpose, message.path);
        }
        return;
      }
      if (message.type === "extensionInstalled") {
        setInstalling(undefined);
        setInstallError(message.ok ? undefined : message.message);
        if (message.ok) handlers.current.afterExtensionInstalled();
      }
    });
    messaging.post({ type: "ready" });
    return unsubscribe;
  }, [messaging]);

  useEffect(() => {
    const editorKey = adding ? "new" : selected?.id;
    if (editorKeyRef.current === editorKey) return;
    editorKeyRef.current = editorKey;
    const requestedSettings = requestedSettingsRef.current === editorKey;
    requestedSettingsRef.current = undefined;
    setSettingsOpen(adding || requestedSettings || !selected?.connected);
    setActiveSection("connection");
    setDraft(selected && !adding ? draftOf(selected) : EMPTY_DRAFT);
    setDirty(false);
    setSaveError(undefined);
    setReport(undefined);
    setConnectionError(undefined);
    setInspection(undefined);
    setInspectionError(undefined);
    setConfirmingDelete(false);
    setSchemaSyncError(undefined);
    setConfirmingProvision(false);
  }, [adding, selected]);

  useEffect(() => {
    if (!selected?.connected || liveHold || settingsOpen || dockerSetupOpen) return;
    const inspect = () => {
      if (document.hidden) return;
      const requestId = ++inspectionSequence.current;
      messaging.post({ type: "inspect", id: selected.id, requestId });
    };
    inspect();
    const timer = window.setInterval(inspect, 15_000);
    return () => window.clearInterval(timer);
  }, [messaging, selected?.id, selected?.connected, liveHold, settingsOpen, dockerSetupOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [contextMenu]);

  const selectConnection = (id: string, openSettings = false) => {
    if (openSettings) requestedSettingsRef.current = id;
    setAdding(false);
    setDockerSetupOpen(false);
    setAppSettingsOpen(false);
    setSelectedId(id);
    setContextMenu(undefined);
    if (id === selectedId && openSettings) setSettingsOpen(true);
  };

  const startAdding = () => {
    setAdding(true);
    setDockerSetupOpen(false);
    setAppSettingsOpen(false);
    setSelectedId(undefined);
    setContextMenu(undefined);
    setDraft(EMPTY_DRAFT);
    setDirty(false);
    setSaveError(undefined);
    setReport(undefined);
    setConnectionError(undefined);
    setInspection(undefined);
    setConfirmingDelete(false);
  };

  const originalId = adding ? undefined : selected?.id;
  const complete =
    draft.host.trim() !== "" && draft.database.trim() !== "" && draft.user.trim() !== "";

  const edit = (change: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setDirty(true);
  };

  const editTuning = (change: Partial<ConnectionTuning>) => {
    setDraft((current) => {
      const tuning = prunedTuning({ ...current.tuning, ...change });
      const { tuning: _previous, ...rest } = current;
      return tuning ? { ...rest, tuning } : rest;
    });
    setDirty(true);
  };
  const pickCertificate = (purpose: "ca" | "cert" | "key") => {
    messaging.post({ type: "pickCertificate", purpose, requestId: ++pickSequence.current });
  };

  const test = () => {
    const requestId = ++testSequence.current;
    setTesting(true);
    setReport(undefined);
    messaging.post({
      type: "test",
      draft,
      ...(originalId === undefined ? {} : { originalId }),
      requestId,
    });
  };

  useEffect(() => {
    if (!testing) return;
    const timer = window.setTimeout(() => {
      setTesting(false);
      setReport({
        ok: false,
        steps: [{ label: "The host did not answer the test", status: "failed" }],
      });
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [testing]);

  useEffect(() => {
    if (installing === undefined) return;
    const timer = window.setTimeout(() => {
      setInstalling(undefined);
      setInstallError(`Installing ${installing} received no answer from the host.`);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [installing]);

  const changeConnection = (action: "connect" | "disconnect", id = selected?.id) => {
    if (!id) return;
    selectConnection(id);
    setTransition({ id, action });
    setConnectionError(undefined);
    messaging.post({ type: action, id });
  };

  const refreshInspection = (id = selected?.id) => {
    if (!id) return;
    selectConnection(id);
    const requestId = ++inspectionSequence.current;
    setInspectionError(undefined);
    messaging.post({ type: "inspect", id, requestId });
  };
  handlers.current = {
    applyCertificate: (purpose, path) => editTuning({ [CERTIFICATE_FIELDS[purpose]]: path }),
    afterExtensionInstalled: () => {
      if (selected?.connected) refreshInspection(selected.id);
      else test();
    },
  };

  const openContextMenu = (event: ReactMouseEvent, connectionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      connectionId,
      left: Math.min(event.clientX, window.innerWidth - 190),
      top: Math.min(event.clientY, window.innerHeight - 180),
    });
  };

  const installExtension = (name: WorkbenchServerExtension) => {
    setInstalling(name);
    setInstallError(undefined);
    messaging.post({
      type: "installExtension",
      name,
      draft,
      ...(originalId === undefined ? {} : { originalId }),
    });
  };

  const setSchemaSyncEnabled = (enabled: boolean) => {
    if (!selected) return;
    setSchemaSyncBusy(true);
    setSchemaSyncError(undefined);
    messaging.post({ type: "setSchemaSyncEnabled", id: selected.id, enabled });
  };

  const provisionSchemaSync = () => {
    if (!selected) return;
    setSchemaSyncBusy(true);
    setSchemaSyncError(undefined);
    messaging.post({ type: "provisionSchemaSync", id: selected.id });
  };

  const monitoredServer =
    inspection && inspection.id === selected?.id ? inspection.server : report?.server;
  const menuConnection = contextMenu
    ? connections.find((connection) => connection.id === contextMenu.connectionId)
    : undefined;

  const standalone =
    dockerSetupOpen || appSettingsOpen || adding || (selected !== undefined && settingsOpen);
  return (
    <div
      className={`connections-page ${sidebarCollapsed ? "connections-sidebar-collapsed" : ""} ${
        standalone ? "connections-standalone" : ""
      }`}
    >
      <aside className="connections-sidebar" aria-label="Saved Connections">
        <header className="connections-sidebar-header">
          <div className="connections-sidebar-heading">
            <span className="connections-kicker">PostgreSQL Workbench</span>
            <h1>Connections</h1>
          </div>
          <div className="connections-sidebar-header-actions">
            <button
              aria-label={sidebarCollapsed ? "Expand Connections" : "Collapse Connections"}
              className="connections-collapse"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              title={sidebarCollapsed ? "Expand Connections" : "Collapse Connections"}
              type="button"
            >
              {sidebarCollapsed ? "›" : "‹"}
            </button>
            <button
              aria-label="New Connection"
              className="connections-primary connections-new"
              onClick={startAdding}
              type="button"
            >
              <span className="connections-new-full">New</span>
              <span aria-hidden="true" className="connections-new-compact">
                +
              </span>
            </button>
          </div>
        </header>
        <div className="connections-sidebar-tools">
          <span>
            {connections.length} saved ·{" "}
            {connections.filter((connection) => connection.connected).length} open
          </span>
          <span className="connections-sidebar-tool-actions">
            <button onClick={() => setAppSettingsOpen(true)} type="button">
              Settings
            </button>
            <button onClick={() => setDockerSetupOpen(true)} type="button">
              Docker setup
            </button>
            <button onClick={() => messaging.post({ type: "import" })} type="button">
              Import
            </button>
          </span>
        </div>

        {connections.length === 0 && !adding ? (
          <div className="connections-empty">
            <strong>No saved Connection</strong>
            <p>Add an endpoint or import one from another PostgreSQL extension.</p>
            <button className="connections-primary" onClick={startAdding} type="button">
              New Connection
            </button>
          </div>
        ) : null}

        <ul className="connections-collection">
          {connections.map((connection) => {
            const changing = transition?.id === connection.id;
            return (
              <li
                aria-current={connection.id === selectedId}
                className="connections-card"
                key={connection.id}
                onContextMenu={(event) => openContextMenu(event, connection.id)}
              >
                <button
                  aria-label={`Inspect ${displayName(connection)}`}
                  className="connections-card-main"
                  onClick={() => selectConnection(connection.id)}
                  type="button"
                >
                  <span className="connections-card-title-row">
                    <span aria-hidden="true" className="connections-card-monogram">
                      {displayName(connection).slice(0, 1).toUpperCase()}
                    </span>
                    <strong>{displayName(connection)}</strong>
                    <ConnectionStatus connection={connection} compact />
                  </span>
                  <span className="connections-card-endpoint">{connectionUrl(connection)}</span>
                </button>
                <div className="connections-card-actions">
                  <button
                    disabled={changing}
                    onClick={() =>
                      changeConnection(
                        connection.connected ? "disconnect" : "connect",
                        connection.id,
                      )
                    }
                    type="button"
                  >
                    {changing
                      ? transition.action === "connect"
                        ? "Opening…"
                        : "Closing…"
                      : connection.connected
                        ? "Disconnect"
                        : "Connect"}
                  </button>
                  <button onClick={() => selectConnection(connection.id, true)} type="button">
                    Settings
                  </button>
                  <button
                    aria-label={`More actions for ${displayName(connection)}`}
                    className="connections-more"
                    onClick={(event) => openContextMenu(event, connection.id)}
                    type="button"
                  >
                    ···
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      {appSettingsOpen ? (
        <main aria-label="Application settings" className="connections-workspace">
          <header className="connections-workspace-header">
            <div>
              <h2>Application Settings</h2>
              <span className="connections-workspace-endpoint">
                Applies to every Connection of this Workbench
              </span>
            </div>
            <button onClick={() => setAppSettingsOpen(false)} type="button">
              Close
            </button>
          </header>
          <div className="connections-workspace-body">
            <div className="connections-settings">
              <div className="connections-settings-layout">
                <nav aria-label="Settings sections" className="connections-settings-nav">
                  <span className="connections-kicker">Application</span>
                  {APP_SECTIONS.map((section) => (
                    <SectionLink
                      active={activeAppSection === section.id}
                      key={section.id}
                      label={section.label}
                      onSelect={() => setActiveAppSection(section.id)}
                    />
                  ))}
                  <SectionLink
                    active={activeAppSection === "schema-sync"}
                    label="Schema sync defaults"
                    onSelect={() => setActiveAppSection("schema-sync")}
                  />
                </nav>
                <div className="connections-settings-content">
                  <div className="connections-form-sections connections-settings-tail">
                    <AppSettingsCard
                      onApply={(key, value) =>
                        messaging.post({ type: "setAppSetting", key, value })
                      }
                      section={activeAppSection}
                      title={
                        activeAppSection === "schema-sync"
                          ? "Schema sync defaults"
                          : (APP_SECTIONS.find((entry) => entry.id === activeAppSection)?.label ??
                            "")
                      }
                      values={appSettings}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      ) : dockerSetupOpen ? (
        <DockerSetup
          onClose={() => setDockerSetupOpen(false)}
          onStart={() => messaging.post({ type: "startDockerDatabase" })}
        />
      ) : adding || selected ? (
        <main aria-label="Connection editor" className="connections-workspace">
          <header className="connections-workspace-header">
            <div>
              <h2>{adding ? "New Connection" : displayName(selected as ConnectionSummary)}</h2>
              {!adding && selected?.name ? (
                <span className="connections-workspace-endpoint">{connectionUrl(selected)}</span>
              ) : null}
            </div>
            {!adding && selected ? (
              <div className="connections-workspace-state">
                <ConnectionStatus connection={selected} />
                {selected.connected ? (
                  <button
                    className={`connections-chip connections-debugger connections-debugger-${selected.debugger.status}`}
                    onClick={() =>
                      document
                        .querySelector('[aria-label="Extensions"]')
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    title={
                      selected.debugger.message ??
                      "PL/pgSQL debugger state on this server — click to see the extensions"
                    }
                    type="button"
                  >
                    {debuggerLabel(selected)}
                  </button>
                ) : null}
                <button
                  className={`connections-chip connections-schema-state connections-schema-state-${selected.schemaSync.status}`}
                  onClick={() => setSettingsOpen(true)}
                  title={
                    selected.schemaSync.message ??
                    "Schema synchronization keeps the index current after DDL — click to manage it"
                  }
                  type="button"
                >
                  {schemaSyncLabel(selected)}
                </button>
              </div>
            ) : null}
          </header>

          {connectionError ? (
            <p className="connections-error connections-banner" role="alert">
              {connectionError}
            </p>
          ) : null}

          <div
            className={`connections-workspace-body ${settingsOpen ? "connections-with-settings" : ""}`}
          >
            {!adding && !settingsOpen ? (
              <section aria-label="Connection monitoring" className="connections-monitor">
                <header className="connections-monitor-header">
                  <div>
                    <h3>Overview</h3>
                    <span>Live server state</span>
                  </div>
                  <div className="connections-monitor-tools">
                    {inspection && inspection.id === selected?.id ? (
                      <span
                        title={`Last update ${new Date(inspection.capturedAt).toLocaleTimeString()}`}
                      >
                        {liveHold ? "Paused — session open" : "Live · 15 s"}
                      </span>
                    ) : null}
                    {selected?.connected ? (
                      <button onClick={() => refreshInspection()} type="button">
                        Refresh
                      </button>
                    ) : null}
                  </div>
                </header>
                {report ? <TestReport report={report} /> : null}
                {inspectionError ? (
                  <p className="connections-error connections-monitor-message" role="alert">
                    {inspectionError}
                  </p>
                ) : null}
                {installError ? (
                  <p className="connections-error connections-monitor-message" role="alert">
                    {installError}
                  </p>
                ) : null}
                {selected ? (
                  <IndexPanel
                    connected={selected.connected}
                    index={selected.index}
                    onRefresh={() => messaging.post({ type: "refreshIndex", id: selected.id })}
                  />
                ) : null}
                {monitoredServer ? (
                  <ServerPanel
                    installing={installing}
                    onInstallExtension={installExtension}
                    onLiveHold={setLiveHold}
                    onStartDockerDatabase={() => messaging.post({ type: "startDockerDatabase" })}
                    server={monitoredServer}
                  />
                ) : (
                  <div className="connections-monitor-empty">
                    <span className="connections-monitor-line" aria-hidden="true" />
                    <strong>
                      {selected?.connected ? "Reading server state…" : "Connection closed"}
                    </strong>
                    <p>
                      {selected?.connected
                        ? "The first live snapshot is on its way."
                        : "Connect it from the sidebar to inspect activity and capabilities."}
                    </p>
                  </div>
                )}
              </section>
            ) : null}

            {settingsOpen ? (
              <aside className={`connections-settings ${adding ? "connections-settings-new" : ""}`}>
                <header>
                  <div>
                    <span className="connections-kicker">{adding ? "Setup" : "Configuration"}</span>
                    <h3>{adding ? "New Connection" : "Settings"}</h3>
                  </div>
                  {!adding ? (
                    <button
                      aria-label="Close settings"
                      onClick={() => setSettingsOpen(false)}
                      type="button"
                    >
                      Close
                    </button>
                  ) : null}
                </header>
                <div className="connections-settings-layout">
                  <nav aria-label="Settings sections" className="connections-settings-nav">
                    <span className="connections-kicker">This Connection</span>
                    {CONNECTION_SECTIONS.map((section) => (
                      <SectionLink
                        active={activeSection === section.id}
                        key={section.id}
                        label={section.label}
                        onSelect={() => setActiveSection(section.id)}
                      />
                    ))}
                    {!adding ? (
                      <>
                        <SectionLink
                          active={activeSection === "schema-sync"}
                          label="Schema sync"
                          onSelect={() => setActiveSection("schema-sync")}
                        />
                        <span className="connections-kicker">Application</span>
                        {APP_SECTIONS.map((section) => (
                          <SectionLink
                            active={activeSection === section.id}
                            key={section.id}
                            label={section.label}
                            onSelect={() => setActiveSection(section.id)}
                          />
                        ))}
                        <SectionLink
                          active={activeSection === "danger"}
                          label="Danger zone"
                          onSelect={() => setActiveSection("danger")}
                        />
                      </>
                    ) : null}
                  </nav>
                  <div className="connections-settings-content">
                    {isConnectionSection(activeSection) ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          messaging.post({
                            type: "save",
                            draft,
                            ...(originalId === undefined ? {} : { originalId }),
                            ...(adding ? { connect: true } : {}),
                          });
                        }}
                      >
                        <div className="connections-form-sections">
                          {activeSection === "connection" ? (
                            <fieldset className="connections-form-section">
                              <legend>Endpoint</legend>
                              <div className="connections-field-row">
                                <label className="connections-field-grow">
                                  <span>Host</span>
                                  <input
                                    onChange={(event) => edit({ host: event.target.value })}
                                    required
                                    value={draft.host}
                                  />
                                </label>
                                <label className="connections-field-port">
                                  <span>Port</span>
                                  <input
                                    max={65535}
                                    min={1}
                                    onChange={(event) =>
                                      edit({ port: Number(event.target.value) || 5432 })
                                    }
                                    type="number"
                                    value={draft.port}
                                  />
                                </label>
                              </div>
                              <label>
                                <span>Database</span>
                                <input
                                  onChange={(event) => edit({ database: event.target.value })}
                                  required
                                  value={draft.database}
                                />
                              </label>
                              <div className="connections-field-row">
                                <label className="connections-field-grow">
                                  <span>User</span>
                                  <input
                                    onChange={(event) => edit({ user: event.target.value })}
                                    required
                                    value={draft.user}
                                  />
                                </label>
                                <label className="connections-field-grow">
                                  <span>Password</span>
                                  <input
                                    autoComplete="off"
                                    onChange={(event) => edit({ password: event.target.value })}
                                    placeholder={
                                      !adding && selected?.hasPassword
                                        ? "Saved — type to replace"
                                        : ""
                                    }
                                    type="password"
                                    value={draft.password ?? ""}
                                  />
                                </label>
                              </div>
                            </fieldset>
                          ) : null}
                          {activeSection === "connection" ? (
                            <fieldset className="connections-form-section">
                              <legend>Identity</legend>
                              <label>
                                <span>Name</span>
                                <input
                                  onChange={(event) =>
                                    edit({ name: event.target.value || undefined })
                                  }
                                  placeholder={connectionUrl(draft)}
                                  value={draft.name ?? ""}
                                />
                              </label>
                              <label>
                                <span>Application name</span>
                                <input
                                  onChange={(event) =>
                                    editTuning({ applicationName: event.target.value || undefined })
                                  }
                                  placeholder="postgresql-workbench (per feature)"
                                  value={draft.tuning?.applicationName ?? ""}
                                />
                              </label>
                              <label className="connections-field-check">
                                <input
                                  checked={draft.tuning?.readOnly ?? false}
                                  onChange={(event) =>
                                    editTuning({ readOnly: event.target.checked || undefined })
                                  }
                                  type="checkbox"
                                />
                                <span>Open every session read-only</span>
                              </label>
                            </fieldset>
                          ) : null}
                          {activeSection === "encryption" ? (
                            <fieldset className="connections-form-section">
                              <legend>Encryption</legend>
                              <label>
                                <span>SSL mode</span>
                                <select
                                  onChange={(event) => edit({ ssl: sslChoice(event.target.value) })}
                                  value={draft.ssl ?? "disable"}
                                >
                                  <option value="disable">Disable — no TLS</option>
                                  <option value="allow">Allow</option>
                                  <option value="prefer">Prefer</option>
                                  <option value="require">
                                    Require — encrypt, trust any certificate
                                  </option>
                                  <option value="verify-ca">Verify CA — check the chain</option>
                                  <option value="verify-full">
                                    Verify full — chain and hostname
                                  </option>
                                </select>
                              </label>
                              {draft.ssl && draft.ssl !== "disable" ? (
                                <>
                                  <CertificateField
                                    label="CA certificate"
                                    onBrowse={() => pickCertificate("ca")}
                                    onChange={(path) => editTuning({ sslRootCert: path })}
                                    value={draft.tuning?.sslRootCert}
                                  />
                                  <CertificateField
                                    label="Client certificate"
                                    onBrowse={() => pickCertificate("cert")}
                                    onChange={(path) => editTuning({ sslCert: path })}
                                    value={draft.tuning?.sslCert}
                                  />
                                  <CertificateField
                                    label="Client key"
                                    onBrowse={() => pickCertificate("key")}
                                    onChange={(path) => editTuning({ sslKey: path })}
                                    value={draft.tuning?.sslKey}
                                  />
                                </>
                              ) : (
                                <p className="connections-form-hint">
                                  Certificates apply once an encrypting mode is chosen.
                                </p>
                              )}
                            </fieldset>
                          ) : null}
                          {activeSection === "sessions" ? (
                            <fieldset className="connections-form-section">
                              <legend>Session defaults</legend>
                              <div className="connections-field-row">
                                <label className="connections-field-grow">
                                  <span>Connect timeout (ms)</span>
                                  <input
                                    min={1000}
                                    onChange={(event) =>
                                      editTuning({
                                        connectTimeoutMs: numberOrUndefined(event.target.value),
                                      })
                                    }
                                    placeholder="10000"
                                    type="number"
                                    value={draft.tuning?.connectTimeoutMs ?? ""}
                                  />
                                </label>
                                <label className="connections-field-grow">
                                  <span>Statement timeout (ms)</span>
                                  <input
                                    min={0}
                                    onChange={(event) =>
                                      editTuning({
                                        statementTimeoutMs: numberOrUndefined(event.target.value),
                                      })
                                    }
                                    placeholder="per feature"
                                    type="number"
                                    value={draft.tuning?.statementTimeoutMs ?? ""}
                                  />
                                </label>
                              </div>
                              <label>
                                <span>search_path</span>
                                <input
                                  onChange={(event) =>
                                    editTuning({ searchPath: event.target.value || undefined })
                                  }
                                  placeholder="schema, public"
                                  value={draft.tuning?.searchPath ?? ""}
                                />
                              </label>
                              <label>
                                <span>Server options</span>
                                <input
                                  onChange={(event) =>
                                    editTuning({ serverOptions: event.target.value || undefined })
                                  }
                                  placeholder="-c work_mem=64MB -c timezone=UTC"
                                  value={draft.tuning?.serverOptions ?? ""}
                                />
                              </label>
                              <label className="connections-field-check">
                                <input
                                  checked={draft.tuning?.keepAlive ?? false}
                                  onChange={(event) =>
                                    editTuning({ keepAlive: event.target.checked || undefined })
                                  }
                                  type="checkbox"
                                />
                                <span>TCP keepalive</span>
                              </label>
                            </fieldset>
                          ) : null}
                        </div>
                        {saveError ? (
                          <p className="connections-error connections-field-wide" role="alert">
                            {saveError}
                          </p>
                        ) : null}
                        <div className="connections-form-actions connections-field-wide">
                          <button
                            className="connections-primary"
                            disabled={!complete || (!dirty && !adding)}
                            type="submit"
                          >
                            {adding ? "Create & Connect" : "Save"}
                          </button>
                          <button disabled={!complete || testing} onClick={test} type="button">
                            {testing ? "Testing…" : "Test Settings"}
                          </button>
                        </div>
                      </form>
                    ) : null}
                    {(testing || report) && isConnectionSection(activeSection) ? (
                      <div className="connections-test-verdict">
                        {testing ? (
                          <p className="connections-form-hint" role="status">
                            Testing the connection…
                          </p>
                        ) : null}
                        {report ? <TestReport report={report} /> : null}
                        {report && adding ? (
                          <p className="connections-form-hint">
                            Create &amp; Connect opens the live server overview.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {!adding && selected && activeSection === "schema-sync" ? (
                      <div className="connections-form-sections connections-settings-tail">
                        <section className="connections-form-section connections-schema-sync">
                          <header>
                            <div>
                              <span className="connections-kicker">Database events</span>
                              <h4>Schema synchronization</h4>
                            </div>
                            <span
                              className={`connections-schema-badge connections-schema-badge-${selected.schemaSync.status}`}
                            >
                              {schemaSyncLabel(selected)}
                            </span>
                          </header>
                          <p>
                            Keep the indexed structure current after DDL changes. DML never triggers
                            this listener.
                          </p>
                          <dl>
                            <div>
                              <dt>Support schema</dt>
                              <dd>{selected.schemaSync.supportSchema}</dd>
                            </div>
                            <div>
                              <dt>Runtime</dt>
                              <dd>{selected.schemaSync.status}</dd>
                            </div>
                          </dl>
                          {selected.schemaSync.message ? (
                            <p className="connections-schema-message">
                              {selected.schemaSync.message}
                            </p>
                          ) : null}
                          {schemaSyncError ? (
                            <p className="connections-error" role="alert">
                              {schemaSyncError}
                            </p>
                          ) : null}
                          <div className="connections-schema-actions">
                            <button
                              disabled={schemaSyncBusy}
                              onClick={() => setSchemaSyncEnabled(!selected.schemaSync.enabled)}
                              type="button"
                            >
                              {selected.schemaSync.enabled ? "Disable" : "Enable"}
                            </button>
                            {selected.schemaSync.enabled &&
                            (selected.schemaSync.status === "provisioning-required" ||
                              selected.schemaSync.status === "insufficient-privilege") ? (
                              confirmingProvision ? (
                                <span className="connections-provision-confirm">
                                  Creates database event triggers. Superuser required.
                                  <button
                                    className="connections-primary"
                                    disabled={schemaSyncBusy}
                                    onClick={provisionSchemaSync}
                                    type="button"
                                  >
                                    {schemaSyncBusy ? "Provisioning…" : "Confirm provisioning"}
                                  </button>
                                  <button
                                    onClick={() => setConfirmingProvision(false)}
                                    type="button"
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button onClick={() => setConfirmingProvision(true)} type="button">
                                  Provision database objects
                                </button>
                              )
                            ) : null}
                          </div>
                        </section>
                        <AppSettingsCard
                          onApply={(key, value) =>
                            messaging.post({ type: "setAppSetting", key, value })
                          }
                          section="schema-sync"
                          title="Defaults for new Connections"
                          values={appSettings}
                        />
                      </div>
                    ) : null}
                    {!adding &&
                    selected &&
                    APP_SECTIONS.some((entry) => entry.id === activeSection) ? (
                      <div className="connections-form-sections connections-settings-tail">
                        <AppSettingsCard
                          onApply={(key, value) =>
                            messaging.post({ type: "setAppSetting", key, value })
                          }
                          section={activeSection as AppSettingSection}
                          title={
                            APP_SECTIONS.find((entry) => entry.id === activeSection)?.label ?? ""
                          }
                          values={appSettings}
                        />
                      </div>
                    ) : null}
                    {!adding && selected && activeSection === "danger" ? (
                      <div className="connections-form-sections connections-settings-tail">
                        <section className="connections-form-section connections-danger-card">
                          <header>
                            <div>
                              <span className="connections-kicker">Danger zone</span>
                              <h4>Delete this Connection</h4>
                            </div>
                          </header>
                          <p>
                            Removes the endpoint and its saved password. Nothing touches the server.
                          </p>
                          <div className="connections-danger-zone">
                            {confirmingDelete ? (
                              <>
                                <span>Delete this Connection and its saved password?</span>
                                <button
                                  className="connections-danger"
                                  onClick={() =>
                                    messaging.post({ type: "delete", id: selected.id })
                                  }
                                  type="button"
                                >
                                  Delete
                                </button>
                                <button onClick={() => setConfirmingDelete(false)} type="button">
                                  Keep
                                </button>
                              </>
                            ) : (
                              <button
                                className="connections-danger"
                                onClick={() => setConfirmingDelete(true)}
                                type="button"
                              >
                                Delete Connection
                              </button>
                            )}
                          </div>
                        </section>
                      </div>
                    ) : null}
                  </div>
                </div>
              </aside>
            ) : null}
          </div>
        </main>
      ) : (
        <main className="connections-workspace connections-workspace-empty">
          <h2>Select a Connection</h2>
          <p>Choose an endpoint from the sidebar.</p>
        </main>
      )}

      {contextMenu && menuConnection ? (
        <div
          className="connections-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          <button
            onClick={() =>
              changeConnection(
                menuConnection.connected ? "disconnect" : "connect",
                menuConnection.id,
              )
            }
            role="menuitem"
            type="button"
          >
            {menuConnection.connected ? "Disconnect" : "Connect"}
          </button>
          {menuConnection.connected ? (
            <button
              onClick={() => refreshInspection(menuConnection.id)}
              role="menuitem"
              type="button"
            >
              Refresh now
            </button>
          ) : null}
          <button
            onClick={() => selectConnection(menuConnection.id, true)}
            role="menuitem"
            type="button"
          >
            Edit settings
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DockerSetup({ onStart, onClose }: { onStart: () => void; onClose: () => void }) {
  return (
    <main aria-label="Local Docker database setup" className="connections-workspace">
      <header className="connections-workspace-header">
        <div>
          <h2>Local PostgreSQL</h2>
          <span className="connections-workspace-endpoint">Docker development environment</span>
        </div>
        <button onClick={onClose} type="button">
          Close
        </button>
      </header>
      <section className="connections-docker-setup">
        <span className="connections-kicker">Assisted setup</span>
        <h3>Install a debugger-ready database</h3>
        <p>
          PostgreSQL Workbench pulls a dedicated image, exposes it only on localhost, saves the
          generated credentials in Secret Storage, and opens the new Connection.
        </p>
        <dl>
          <div>
            <dt>Image</dt>
            <dd>galien0xffffff/postgres-debugger</dd>
          </div>
          <div>
            <dt>Includes</dt>
            <dd>PL/pgSQL debugger support</dd>
          </div>
          <div>
            <dt>Requires</dt>
            <dd>A running Docker daemon</dd>
          </div>
        </dl>
        <div className="connections-docker-setup-actions">
          <button className="connections-primary" onClick={onStart} type="button">
            Open setup assistant
          </button>
          <span>You will choose the PostgreSQL version and local port next.</span>
        </div>
      </section>
    </main>
  );
}

function ConnectionStatus({
  connection,
  compact = false,
}: {
  connection: ConnectionSummary;
  compact?: boolean;
}) {
  return (
    <span
      aria-label={connection.connected ? "Connected" : "Disconnected"}
      className={`connections-status ${connection.connected ? "connections-status-online" : ""} ${compact ? "connections-status-compact" : ""}`}
      role="status"
      title={connection.connected ? "Connected" : "Disconnected"}
    >
      <span aria-hidden="true" />
      {compact ? null : connection.connected ? "Connected" : "Disconnected"}
    </span>
  );
}

function debuggerLabel(connection: ConnectionSummary): string {
  switch (connection.debugger.status) {
    case "available":
      return "Debugger ready";
    case "checking":
      return "Checking debugger";
    case "unavailable":
    case "error":
      return "Debugger unavailable";
    default:
      return "Debugger not checked";
  }
}

function schemaSyncLabel(connection: ConnectionSummary): string {
  switch (connection.schemaSync.status) {
    case "listening":
      return "Sync listening";
    case "provisioning-required":
      return "Sync setup required";
    case "insufficient-privilege":
      return "Sync needs privileges";
    case "desynchronized":
      return "Sync behind";
    case "unavailable":
      return connection.schemaSync.enabled ? "Sync unavailable" : "Sync off";
    default:
      return "Sync off";
  }
}

function TestReport({ report }: { report: ConnectionTestReport }) {
  return (
    <section
      aria-label="Connection test result"
      className={`connections-report ${report.ok ? "connections-report-ok" : "connections-report-failed"}`}
    >
      <ul>
        {report.steps.map((step) => (
          <li className={`connections-step-${step.status}`} key={step.label}>
            <span className="connections-step-mark">{STEP_MARK[step.status]}</span>
            <span>{step.label}</span>
            {step.detail ? <span className="connections-step-detail">{step.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEP_MARK = { ok: "✓", failed: "×", skipped: "–" } as const;

const EMPTY_DRAFT: ConnectionDraft = {
  host: "localhost",
  port: 5432,
  database: "",
  user: "",
};

function draftOf(connection: ConnectionSummary): ConnectionDraft {
  return {
    ...(connection.name === undefined ? {} : { name: connection.name }),
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ...(connection.ssl === undefined ? {} : { ssl: connection.ssl }),
    ...(connection.tuning === undefined ? {} : { tuning: connection.tuning }),
  };
}

type SettingsSection =
  | "connection"
  | "encryption"
  | "sessions"
  | "schema-sync"
  | AppSettingSection
  | "danger";

const CONNECTION_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "encryption", label: "Encryption" },
  { id: "sessions", label: "Sessions" },
];

const APP_SECTION_LABELS: Record<Exclude<AppSettingSection, "schema-sync">, string> = {
  authoring: "SQL & authoring",
  results: "Results & Data View",
  coverage: "Tests & coverage",
  engine: "Workbench engine",
};

const APP_SECTIONS = (
  Object.entries(APP_SECTION_LABELS) as [Exclude<AppSettingSection, "schema-sync">, string][]
).map(([id, label]) => ({ id, label }));

function isConnectionSection(section: SettingsSection): boolean {
  return section === "connection" || section === "encryption" || section === "sessions";
}

function SectionLink({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={active}
      className="connections-settings-nav-link"
      onClick={onSelect}
      type="button"
    >
      {label}
    </button>
  );
}

/** One application rubric: every declared setting of the section, applied as it changes. */
function AppSettingsCard({
  section,
  title,
  values,
  onApply,
}: {
  section: AppSettingSection;
  title: string;
  values: Record<string, AppSettingValue>;
  onApply: (key: string, value: AppSettingValue | undefined) => void;
}) {
  const descriptors = APP_SETTINGS.filter((descriptor) => descriptor.section === section);
  return (
    <section className="connections-form-section connections-app-settings">
      <header>
        <div>
          <span className="connections-kicker">Applies to every Connection</span>
          <h4>{title}</h4>
        </div>
      </header>
      {descriptors.map((descriptor) => (
        <AppSettingField
          descriptor={descriptor}
          key={descriptor.key}
          onApply={(value) => onApply(descriptor.key, value)}
          value={values[descriptor.key] ?? descriptor.default}
        />
      ))}
    </section>
  );
}

function AppSettingField({
  descriptor,
  value,
  onApply,
}: {
  descriptor: AppSettingDescriptor;
  value: AppSettingValue;
  onApply: (value: AppSettingValue | undefined) => void;
}) {
  if (descriptor.kind === "boolean") {
    return (
      <label className="connections-field-check" title={descriptor.description}>
        <input
          checked={Boolean(value)}
          onChange={(event) => onApply(event.target.checked)}
          type="checkbox"
        />
        <span>{descriptor.label}</span>
      </label>
    );
  }
  if (descriptor.kind === "select") {
    return (
      <label title={descriptor.description}>
        <span>{descriptor.label}</span>
        <select onChange={(event) => onApply(event.target.value)} value={String(value)}>
          {(descriptor.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (descriptor.kind === "list") {
    return (
      <label title={descriptor.description}>
        <span>{descriptor.label}</span>
        <input
          onChange={(event) =>
            onApply(
              event.target.value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry !== ""),
            )
          }
          placeholder={(descriptor.default as readonly string[]).join(", ")}
          value={Array.isArray(value) ? value.join(", ") : ""}
        />
      </label>
    );
  }
  if (descriptor.kind === "number") {
    return (
      <label title={descriptor.description}>
        <span>{descriptor.label}</span>
        <input
          {...(descriptor.minimum === undefined ? {} : { min: descriptor.minimum })}
          {...(descriptor.maximum === undefined ? {} : { max: descriptor.maximum })}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onApply(event.target.value !== "" && Number.isFinite(parsed) ? parsed : undefined);
          }}
          placeholder={String(descriptor.default)}
          type="number"
          value={typeof value === "number" ? value : ""}
        />
      </label>
    );
  }
  return (
    <label title={descriptor.description}>
      <span>{descriptor.label}</span>
      <input
        onChange={(event) => onApply(event.target.value || undefined)}
        placeholder={String(descriptor.default)}
        value={String(value ?? "")}
      />
    </label>
  );
}

const CERTIFICATE_FIELDS = {
  ca: "sslRootCert",
  cert: "sslCert",
  key: "sslKey",
} as const;

/** A tuning object with every empty choice removed; undefined once nothing is chosen. */
function prunedTuning(tuning: ConnectionTuning): ConnectionTuning | undefined {
  const pruned = Object.fromEntries(
    Object.entries(tuning).filter(
      ([, value]) => value !== undefined && value !== "" && value !== false,
    ),
  ) as ConnectionTuning;
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function CertificateField({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value?: string;
  onChange: (path: string | undefined) => void;
  onBrowse: () => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <span className="connections-field-browse">
        <input
          onChange={(event) => onChange(event.target.value || undefined)}
          placeholder="Path to a PEM file"
          value={value ?? ""}
        />
        <button onClick={onBrowse} type="button">
          Browse…
        </button>
      </span>
    </label>
  );
}

function displayName(connection: ConnectionSummary): string {
  return getConnectionName(connection);
}

/** The canonical URL for a saved identity; a draft still being typed shows placeholders. */
function connectionUrl(identity: Pick<ConnectionDraft, "host" | "port" | "database" | "user">) {
  if (identity.host && identity.database && identity.user)
    return getConnectionUrl(identity as Parameters<typeof getConnectionUrl>[0]);
  return `${identity.user || "…"}@${identity.host || "…"}:${identity.port}/${identity.database || "…"}`;
}

function sslChoice(value: string): SslMode | undefined {
  return value === "allow" ||
    value === "prefer" ||
    value === "require" ||
    value === "verify-ca" ||
    value === "verify-full"
    ? value
    : undefined;
}
