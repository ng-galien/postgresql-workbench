import { randomUUID } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { preparedAcceptanceVSCode } from "./vscodeDownload";

const extensionRoot = resolve(__dirname, "../../..");
const workspace = resolve(extensionRoot, "tests", "workspace");
const artifactsRoot = resolve(
  extensionRoot,
  "test-results",
  "acceptance-worker",
  process.env.PGWB_ACCEPTANCE_LANE ?? "default",
);
const workbenchActivityLabel = "PostgreSQL Workbench";

async function bounded<T>(promise: Promise<T>, timeout: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, timeout)),
  ]);
}

function recordBootstrapStage(stage: string): void {
  writeFileSync(
    join(artifactsRoot, "bootstrap-stage.json"),
    `${JSON.stringify({ stage, timestamp: new Date().toISOString() }, null, 2)}\n`,
  );
}

interface ExtensionReadyState {
  activationId: string;
  commandNonce?: string;
  result?: unknown;
  status: "ready";
}

function readReadyState(path: string): ExtensionReadyState | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionReadyState>;
    if (
      state.status === "ready" &&
      typeof state.activationId === "string" &&
      (state.commandNonce === undefined || typeof state.commandNonce === "string")
    ) {
      return state as ExtensionReadyState;
    }
  } catch {
    // The extension writes this file atomically enough for the next polling iteration to retry.
  }
  return undefined;
}

async function waitForCommand(
  path: string,
  activationId: string,
  commandNonce: string,
  timeout: number,
  description: string,
): Promise<ExtensionReadyState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = readReadyState(path);
    if (state?.activationId === activationId && state.commandNonce === commandNonce) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} did not complete within ${timeout} ms`);
}

interface ElectronWindowState {
  area: number;
  devicePixelRatio: number;
  focused: boolean;
  id: number;
  rendererHeight: number;
  rendererWidth: number;
  title: string;
  url: string;
  visible: boolean;
  workbenchActivityVisible: boolean;
}

async function electronWindowState(
  app: ElectronApplication,
  page: Page,
): Promise<ElectronWindowState> {
  const browserWindow = await app.browserWindow(page);
  try {
    const state = await browserWindow.evaluate((window) => {
      const [width, height] = window.getContentSize();
      return {
        area: width * height,
        focused: window.isFocused(),
        id: window.id,
        title: window.getTitle(),
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      };
    });
    const renderer = await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    return {
      ...state,
      devicePixelRatio: renderer.devicePixelRatio,
      rendererHeight: renderer.height,
      rendererWidth: renderer.width,
      workbenchActivityVisible: await page
        .getByLabel(workbenchActivityLabel, { exact: true })
        .first()
        .isVisible()
        .catch(() => false),
    };
  } finally {
    await browserWindow.dispose();
  }
}

async function writeWindowFailureDiagnostic(
  app: ElectronApplication,
  name: string,
  timeout: number,
): Promise<ElectronWindowState[]> {
  const windows: ElectronWindowState[] = [];
  let snapshot = 0;
  for (const page of app.windows()) {
    if (page.isClosed()) continue;
    snapshot += 1;
    await bounded(
      page.screenshot({ path: join(artifactsRoot, `${name}-window-${snapshot}.png`) }),
      2_000,
    );
    const state = await bounded(electronWindowState(app, page), 2_000);
    if (!state) continue;
    windows.push(state);
  }
  writeFileSync(
    join(artifactsRoot, `${name}.json`),
    `${JSON.stringify({ timeout, windows }, null, 2)}\n`,
  );
  return windows;
}

async function waitForVSCodeWindow(app: ElectronApplication, timeout: number): Promise<Page> {
  const deadline = Date.now() + timeout;
  let lastStates: ElectronWindowState[] = [];
  while (Date.now() < deadline) {
    const candidates: Array<{ page: Page; state: ElectronWindowState }> = [];
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      const state = await bounded(electronWindowState(app, page), 2_000);
      if (state?.visible) candidates.push({ page, state });
    }
    lastStates = candidates.map(({ state }) => state);
    const focused = candidates.find(({ state }) => state.focused);
    if (focused) return focused.page;
    candidates.sort((left, right) => right.state.area - left.state.area);
    if (candidates[0]) return candidates[0].page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const windows = await writeWindowFailureDiagnostic(app, "vscode-window-error", timeout);
  throw new Error(
    `No visible VS Code Electron window appeared within ${timeout} ms. BrowserWindow states:\n${JSON.stringify(windows.length > 0 ? windows : lastStates, null, 2)}. Snapshots: ${artifactsRoot}/vscode-window-error-window-*.png`,
  );
}

async function waitForWorkbenchWindow(app: ElectronApplication, timeout: number): Promise<Page> {
  const deadline = Date.now() + timeout;
  let lastStates: ElectronWindowState[] = [];
  while (Date.now() < deadline) {
    const states: ElectronWindowState[] = [];
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      const state = await bounded(electronWindowState(app, page), 2_000);
      if (!state?.visible) continue;
      states.push(state);
      const activity = page.getByLabel(workbenchActivityLabel, { exact: true }).first();
      if (await activity.isVisible().catch(() => false)) return page;
    }
    lastStates = states;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const windows = await writeWindowFailureDiagnostic(app, "workbench-window-error", timeout);
  throw new Error(
    `No visible VS Code window exposed the ${JSON.stringify(workbenchActivityLabel)} activity within ${timeout} ms. BrowserWindow states:\n${JSON.stringify(windows.length > 0 ? windows : lastStates, null, 2)}. Snapshots: ${artifactsRoot}/workbench-window-error-window-*.png`,
  );
}

async function waitForWorkbenchViews(app: ElectronApplication, timeout: number): Promise<Page> {
  const page = await waitForWorkbenchWindow(app, timeout);
  await Promise.all(
    ["Connections", "Scratchpads"].map((name) =>
      page
        .locator(".pane-header")
        .filter({ hasText: new RegExp(`^${name}$`, "iu") })
        .first()
        .waitFor({ state: "visible", timeout }),
    ),
  );
  await page
    .getByRole("tree", { name: "Connections", exact: true })
    .waitFor({ state: "visible", timeout });
  return page;
}

async function waitForActivation(
  path: string,
  previousActivationId: string | undefined,
  timeout: number,
  description: string,
  app?: ElectronApplication,
): Promise<ExtensionReadyState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = readReadyState(path);
    if (state && state.activationId !== previousActivationId) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const windows = app
    ? await writeWindowFailureDiagnostic(app, "extension-activation-error", timeout)
    : [];
  throw new Error(
    `${description} did not complete within ${timeout} ms. BrowserWindow states:\n${JSON.stringify(windows, null, 2)}. Snapshots: ${artifactsRoot}/extension-activation-error-window-*.png`,
  );
}

export interface VSCodeInstance {
  app: ElectronApplication;
  page: Page;
  armIndexPhaseGate(phases: readonly WorkbenchIndexPhase[]): Promise<void>;
  executeCommand(
    command:
      | "testing.coverageAll"
      | "testing.openCoverage"
      | "testing.runAll"
      | "testing.toggleInlineCoverage"
      | "postgresql-workbench-connections.focus"
      | "postgresql-workbench.openDataView"
      | "editor.action.formatDocument"
      | "workbench.action.files.saveAll"
      | "workbench.action.joinAllGroups"
      | "workbench.action.newGroupRight"
      | "workbench.action.debug.continue"
      | "workbench.action.debug.start"
      | "postgresql-workbench.acceptance.startDebugConfiguration"
      | "postgresql-workbench.acceptance.closeActiveEditor"
      | "workbench.action.debug.stepInto"
      | "workbench.action.debug.stepOver"
      | "workbench.action.quickOpen"
      | "workbench.view.testing.focus"
      | "postgresql-workbench.editConnection"
      | "postgresql-workbench.removeConnection"
      | "postgresql-workbench.renameConnection",
    timeout?: number,
    arguments_?: unknown[],
  ): Promise<void>;
  executeInfrastructureCommand(command: "workbench.action.reloadWindow"): Promise<void>;
  inspectActiveNotebook(): Promise<ActiveNotebookSnapshot | undefined>;
  inspectActiveTextEditor(): Promise<ActiveTextEditorSnapshot | undefined>;
  inspectDebugConfigurations(): Promise<DebugConfigurationSnapshot[]>;
  inspectDebugState(): Promise<DebugStateSnapshot>;
  inspectTestingState(): Promise<TestingStateSnapshot>;
  inspectWorkbenchState(): Promise<WorkbenchStateSnapshot>;
  removeConnection(id: string): Promise<void>;
  openWorkspaceFile(fileName: string): Promise<void>;
  openSqlDocument(content: string): Promise<void>;
  resetWorkbenchUI(): Promise<void>;
  releaseIndexPhaseGate(runId: number, phase: WorkbenchIndexPhase): Promise<void>;
  resizeWindow(width: number, height: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface DebugConfigurationSnapshot extends Record<string, unknown> {
  name?: string;
  request?: string;
  connection?: string;
  sql?: string;
  stopOnEntry?: boolean;
  type?: string;
}

export type WorkbenchIndexPhase =
  | "reading-catalog"
  | "connecting-index"
  | "publishing-sources"
  | "reading-symbols"
  | "checking-relations"
  | "cancelling";

export interface WorkbenchIndexActiveRun {
  cancelled: boolean;
  id: number;
  retainedGeneration?: number | null;
  scope: string;
  connectionId: string;
}

export interface WorkbenchStateSnapshot {
  connection: {
    connected: boolean;
    connectedConnectionIds: string[];
  };
  schemaSync: Array<{
    connectionId: string;
    desired?: {
      enabled: boolean;
      supportSchema: string;
    };
    state: {
      connectionId: string;
      status:
        | "disabled"
        | "provisioning-required"
        | "listening"
        | "insufficient-privilege"
        | "unavailable"
        | "desynchronized";
      supportSchema: string;
      message?: string;
    };
    listener?: {
      processId?: number;
      supportSchema: string;
      databaseOid: number;
      queuedNotifications: number;
      flushScheduled: boolean;
      flushActive: boolean;
    };
    lifecycle: {
      epoch: number;
      active: boolean;
      starting: boolean;
      reconnectScheduled: boolean;
      queued: number;
    };
    refresh: {
      active: boolean;
      queued: number;
    };
    lastReceivedTransactionId?: string;
    lastCompletedTransactionId?: string;
  }>;
  index: {
    activeRun?: WorkbenchIndexActiveRun;
    activeRuns: WorkbenchIndexActiveRun[];
    currentRunPending: boolean;
    pendingRuns: Array<{ scope: string; connectionId: string }>;
    events: Array<{
      changeKind?: "full" | "incremental";
      generation?: number | null;
      message?: string;
      phase?: WorkbenchIndexPhase;
      runId?: number;
      sequence: number;
      connectionId?: string;
      status: string;
    }>;
    gate?: {
      nextPhase?: WorkbenchIndexPhase;
      phases: WorkbenchIndexPhase[];
      reachedPhase?: WorkbenchIndexPhase;
      runId?: number;
    };
    lastSettledRun?: { id: number; status: string };
    runSequence: number;
    sourceMutationsActive: number;
    states: Array<{
      change?: {
        kind: "full" | "incremental";
        schemas: string[];
        sourceUris: string[];
      };
      progress?: {
        completed?: number;
        phase: WorkbenchIndexPhase;
        total?: number;
        unit?: "sources" | "symbols";
      };
      result?: {
        database: string;
        documents: number;
        generation: number | null;
        revision: string;
        connectionId: string;
        symbols: number;
      };
      connectionId?: string;
      status: string;
    }>;
    state: {
      change?: {
        kind: "full" | "incremental";
        schemas: string[];
        sourceUris: string[];
      };
      progress?: {
        completed?: number;
        phase: WorkbenchIndexPhase;
        total?: number;
        unit?: "sources" | "symbols";
      };
      result?: {
        database: string;
        documents: number;
        generation: number | null;
        revision: string;
        connectionId: string;
        symbols: number;
      };
      connectionId?: string;
      status: string;
    };
  };
}

export interface ActiveNotebookSnapshot {
  cells: Array<{
    kind: "code" | "markup";
    languageId: string;
    outputs: string[];
    outputGroups: string[][];
    text: string;
  }>;
  notebookType: string;
  uri: string;
}

export interface ActiveTextEditorSnapshot {
  languageId: string;
  text: string;
  uri: string;
}

export interface DebugStateSnapshot {
  breakpoints?: Array<{
    enabled: boolean;
    line?: number;
    uri?: string;
  }>;
  extensionSession?: {
    adapterSessionId?: string;
    state?: string;
    status?: {
      state?: string;
      timestamp?: string;
    };
    vscodeSessionId?: string;
  };
  vscodeSessionId?: string;
}

export interface TestingStateSnapshot {
  index?: {
    database?: string;
    generation?: number | null;
    revision?: string;
    connectionId?: string;
    status: string;
  };
  coverage?: {
    files: Array<{
      branch?: { covered: number; total: number };
      statement: { covered: number; total: number };
      uri: string;
    }>;
    outcomes: Record<string, string>;
    sequence: number;
  };
  run?: {
    outcomes: Record<string, string>;
    sequence: number;
  };
}

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const tolerance = 32;
  const deadline = Date.now() + 5_000;
  let lastDimensions:
    | {
        devicePixelRatio: number;
        nativeHeight: number;
        nativeWidth: number;
        rendererHeight: number;
        rendererWidth: number;
      }
    | undefined;
  let lastError: string | undefined;
  await setNativeWindowSize(app, page, width, height);
  while (Date.now() < deadline) {
    try {
      const [nativeWidth, nativeHeight] = await readNativeWindowSize(app, page);
      const renderer = await page.evaluate(() => ({
        devicePixelRatio: window.devicePixelRatio,
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      lastDimensions = {
        devicePixelRatio: renderer.devicePixelRatio,
        nativeHeight,
        nativeWidth,
        rendererHeight: renderer.height,
        rendererWidth: renderer.width,
      };
      if (
        Math.abs(nativeWidth - width) <= tolerance &&
        Math.abs(nativeHeight - height) <= tolerance &&
        Math.abs(renderer.width - width) <= tolerance &&
        Math.abs(renderer.height - height) <= tolerance
      ) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const diagnostic = {
    actual: lastDimensions,
    delta: lastDimensions
      ? {
          nativeHeight: lastDimensions.nativeHeight - height,
          nativeWidth: lastDimensions.nativeWidth - width,
          rendererHeight: lastDimensions.rendererHeight - height,
          rendererWidth: lastDimensions.rendererWidth - width,
        }
      : undefined,
    error: lastError,
    requested: { height, width },
    tolerance,
  };
  const diagnosticPath = join(artifactsRoot, "window-resize-error.json");
  const screenshotPath = join(artifactsRoot, "window-resize-error.png");
  writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
  await page.screenshot({ path: screenshotPath }).catch(() => undefined);
  throw new Error(
    `VS Code window did not settle within 5000 ms. Dimensions: ${JSON.stringify(diagnostic)}. Snapshot: ${screenshotPath}`,
  );
}

async function setNativeWindowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const browserWindow = await app.browserWindow(page);
  try {
    await browserWindow.evaluate((window, size) => window.setContentSize(size.width, size.height), {
      height,
      width,
    });
  } finally {
    await browserWindow.dispose();
  }
}

async function readNativeWindowSize(
  app: ElectronApplication,
  page: Page,
): Promise<[number, number]> {
  const browserWindow = await app.browserWindow(page);
  try {
    return await browserWindow.evaluate((window) => window.getContentSize());
  } finally {
    await browserWindow.dispose();
  }
}

async function focusWindow(app: ElectronApplication, page: Page): Promise<void> {
  await page.bringToFront();
  const browserWindow = await app.browserWindow(page);
  try {
    await browserWindow.evaluate((window) => {
      window.show();
      window.focus();
    });
  } finally {
    await browserWindow.dispose();
  }
}

export interface LaunchVSCodeOptions {
  activationTimeout?: number;
  viewTimeout?: number;
  windowTimeout?: number;
}

export async function launchVSCode(options: LaunchVSCodeOptions = {}): Promise<VSCodeInstance> {
  // Video recording and trace snapshots can deadlock VS Code's Electron renderer on
  // GitHub-hosted Linux runners. Keep the richer artifacts for local diagnosis;
  // CI captures the Xvfb root window and VS Code logs instead.
  const minimalDiagnostics =
    process.env.CI === "true" || process.env.PGWB_PLAYWRIGHT_MINIMAL_DIAGNOSTICS === "1";
  const tracingAsked = !minimalDiagnostics && process.env.PGWB_PLAYWRIGHT_TRACE === "1";
  const activationTimeout = options.activationTimeout ?? 30_000;
  const viewTimeout = options.viewTimeout ?? 30_000;
  const windowTimeout = options.windowTimeout ?? 30_000;
  const { executablePath } = preparedAcceptanceVSCode();
  const profileRoot = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pgwb-acceptance-"),
  );
  const userDataDir = join(profileRoot, "user");
  const extensionsDir = join(profileRoot, "extensions");
  const controlFile = join(profileRoot, "acceptance-command.json");
  const readyFile = `${controlFile}.ready`;
  const settingsPath = join(userDataDir, "User", "settings.json");
  rmSync(artifactsRoot, { recursive: true, force: true });
  mkdirSync(dirname(settingsPath), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      "security.workspace.trust.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "editor.wordBasedSuggestions": "off",
      "git.openRepositoryInParentFolders": "never",
      "postgresql-workbench.acceptanceControlFile": controlFile,
      "window.dialogStyle": "custom",
      "workbench.startupEditor": "none",
      "workbench.colorTheme": "Default Light Modern",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    }),
  );
  if (!existsSync(workspace)) throw new Error(`Acceptance workspace missing: ${workspace}`);

  let app: ElectronApplication | undefined;
  let tracingStarted = false;
  let disposed = false;
  /** How long each step of the shutdown took, so a slow one is read rather than guessed at. */
  const timing: Record<string, number> = {};
  const timed = async (step: string, work: () => Promise<unknown>) => {
    const start = Date.now();
    await work().catch(() => undefined);
    timing[step] = Date.now() - start;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const traced = app;
    if (traced && tracingStarted) {
      await timed("tracing", () =>
        traced.context().tracing.stop({ path: join(artifactsRoot, "trace.zip") }),
      );
    }
    await timed("close", async () => app?.close());
    const vscodeLogs = join(userDataDir, "logs");
    if (existsSync(vscodeLogs)) {
      cpSync(vscodeLogs, join(artifactsRoot, "vscode-logs"), { recursive: true });
    }
    rmSync(profileRoot, { recursive: true, force: true });
    writeFileSync(
      join(artifactsRoot, "teardown-timing.json"),
      `${JSON.stringify({ traced: tracingStarted, ...timing }, null, 2)}\n`,
    );
  };

  try {
    app = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE: controlFile,
      },
      args: [
        "--disable-gpu-sandbox",
        "--disable-updates",
        "--force-disable-user-env",
        "--use-inmemory-secretstorage",
        "--locale=en",
        "--new-window",
        "--verbose",
        "--skip-release-notes",
        "--skip-welcome",
        "--no-sandbox",
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--extensionDevelopmentPath=${extensionRoot}`,
        workspace,
      ],
      recordVideo: minimalDiagnostics
        ? undefined
        : { dir: join(artifactsRoot, "video"), size: { width: 1440, height: 900 } },
    });
    app.process().stdout?.pipe(createWriteStream(join(artifactsRoot, "electron-stdout.log")));
    app.process().stderr?.pipe(createWriteStream(join(artifactsRoot, "electron-stderr.log")));
    /*
     * One VS Code serves every scenario of a lane, so a trace covers the whole run: minutes of
     * screenshots and DOM snapshots across every webview VS Code holds. Collecting them costs as
     * much as the run is long — two minutes of shutdown for a seven-minute lane, paid whether or
     * not the zip is kept — so it is asked for, by whoever is about to read one. The film of the
     * run is recorded either way: it costs seconds and shows what happened.
     */
    if (tracingAsked) {
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      tracingStarted = true;
    }
    recordBootstrapStage("waiting-for-vscode-window");
    await waitForVSCodeWindow(app, windowTimeout);
    recordBootstrapStage("waiting-for-extension-activation");
    let ready = await waitForActivation(
      readyFile,
      undefined,
      activationTimeout,
      "PostgreSQL Workbench extension activation",
      app,
    );
    recordBootstrapStage("extension-ready");

    const runningApp = app;
    const runAcceptanceCommand = async (
      command: string,
      timeout = 5_000,
      arguments_?: unknown[],
    ): Promise<ExtensionReadyState> => {
      const nonce = randomUUID();
      writeFileSync(controlFile, JSON.stringify({ arguments: arguments_, command, nonce }));
      ready = await waitForCommand(
        readyFile,
        ready.activationId,
        nonce,
        timeout,
        `VS Code command ${command}`,
      );
      return ready;
    };
    await runAcceptanceCommand("postgresql-workbench-connections.focus");
    recordBootstrapStage("waiting-for-workbench-window");
    let page = await waitForWorkbenchViews(app, viewTimeout);
    await resizeWindow(app, page, 1440, 900);
    recordBootstrapStage("ready");
    return {
      app: runningApp,
      get page() {
        return page;
      },
      async armIndexPhaseGate(phases) {
        await runAcceptanceCommand("postgresql-workbench.acceptance.armIndexPhaseGate", 5_000, [
          phases,
        ]);
      },
      async executeCommand(command, timeout, arguments_) {
        await focusWindow(runningApp, page);
        await runAcceptanceCommand(command, timeout, arguments_);
      },
      async executeInfrastructureCommand(command) {
        const previousActivationId = ready.activationId;
        writeFileSync(controlFile, JSON.stringify({ command, nonce: randomUUID() }));
        ready = await waitForActivation(
          readyFile,
          previousActivationId,
          30_000,
          `VS Code command ${command} and subsequent extension activation`,
          runningApp,
        );
        await waitForVSCodeWindow(runningApp, 30_000);
        await runAcceptanceCommand("postgresql-workbench-connections.focus", viewTimeout);
        page = await waitForWorkbenchViews(runningApp, viewTimeout);
      },
      async inspectActiveNotebook() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectActiveNotebook",
        );
        return state.result as ActiveNotebookSnapshot | undefined;
      },
      async inspectActiveTextEditor() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectActiveTextEditor",
        );
        return state.result as ActiveTextEditorSnapshot | undefined;
      },
      async inspectDebugConfigurations() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectDebugConfigurations",
        );
        return (state.result ?? []) as DebugConfigurationSnapshot[];
      },
      async inspectDebugState() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectDebugState",
        );
        return state.result as DebugStateSnapshot;
      },
      async inspectTestingState() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectTestingState",
        );
        return (state.result ?? {}) as TestingStateSnapshot;
      },
      async inspectWorkbenchState() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectWorkbenchState",
        );
        return state.result as WorkbenchStateSnapshot;
      },
      async removeConnection(id) {
        await runAcceptanceCommand("postgresql-workbench.acceptance.removeConnection", 5_000, [id]);
      },
      async openWorkspaceFile(fileName) {
        await runAcceptanceCommand("postgresql-workbench.acceptance.openWorkspaceFile", 5_000, [
          fileName,
        ]);
      },
      async openSqlDocument(content) {
        await runAcceptanceCommand("postgresql-workbench.acceptance.openSqlDocument", 5_000, [
          content,
        ]);
      },
      async resetWorkbenchUI() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.resetWorkbench",
          10_000,
        );
        const result = state.result as { remainingTabCount?: unknown } | undefined;
        if (result?.remainingTabCount !== 0) {
          throw new Error(
            `VS Code still exposes ${String(result?.remainingTabCount)} editor tabs after the acceptance reset`,
          );
        }
        page = await waitForWorkbenchViews(runningApp, viewTimeout);
      },
      async releaseIndexPhaseGate(runId, phase) {
        await runAcceptanceCommand("postgresql-workbench.acceptance.releaseIndexPhaseGate", 5_000, [
          runId,
          phase,
        ]);
      },
      async resizeWindow(width, height) {
        await resizeWindow(runningApp, page, width, height);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
