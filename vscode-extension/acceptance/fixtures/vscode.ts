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

const extensionRoot = resolve(__dirname, "../..");
const workspace = resolve(extensionRoot, "test-workspace");
const artifactsRoot = resolve(extensionRoot, "test-results", "acceptance-worker");
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
  executeCommand(
    command:
      | "testing.coverageAll"
      | "testing.runAll"
      | "workbench.action.quickOpen"
      | "workbench.view.testing.focus",
    timeout?: number,
  ): Promise<void>;
  executeInfrastructureCommand(command: "workbench.action.reloadWindow"): Promise<void>;
  inspectActiveNotebook(): Promise<ActiveNotebookSnapshot | undefined>;
  inspectDebugState(): Promise<DebugStateSnapshot>;
  inspectTestingState(): Promise<TestingStateSnapshot>;
  resetWorkbenchUI(): Promise<void>;
  resizeWindow(width: number, height: number): Promise<void>;
  dispose(): Promise<void>;
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

export interface DebugStateSnapshot {
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
    serverId?: string;
    status: string;
  };
  coverage?: {
    files: Array<{
      branch?: { covered: number; total: number };
      statement: { covered: number; total: number };
      uri: string;
    }>;
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
  const browserWindow = await app.browserWindow(page);
  let lastDimensions:
    | {
        devicePixelRatio: number;
        nativeHeight: number;
        nativeWidth: number;
        rendererHeight: number;
        rendererWidth: number;
      }
    | undefined;
  try {
    await browserWindow.evaluate((window, size) => window.setContentSize(size.width, size.height), {
      width,
      height,
    });
    while (Date.now() < deadline) {
      const [nativeWidth, nativeHeight] = await browserWindow.evaluate((window) =>
        window.getContentSize(),
      );
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
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (app && tracingStarted) {
      await app
        .context()
        .tracing.stop({ path: join(artifactsRoot, "trace.zip") })
        .catch(() => {});
    }
    await app?.close().catch(() => undefined);
    const vscodeLogs = join(userDataDir, "logs");
    if (existsSync(vscodeLogs)) {
      cpSync(vscodeLogs, join(artifactsRoot, "vscode-logs"), { recursive: true });
    }
    rmSync(profileRoot, { recursive: true, force: true });
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
      recordVideo: { dir: join(artifactsRoot, "video"), size: { width: 1440, height: 900 } },
    });
    app.process().stdout?.pipe(createWriteStream(join(artifactsRoot, "electron-stdout.log")));
    app.process().stderr?.pipe(createWriteStream(join(artifactsRoot, "electron-stderr.log")));
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
    recordBootstrapStage("waiting-for-vscode-window");
    const page = await waitForVSCodeWindow(app, windowTimeout);
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
    ): Promise<ExtensionReadyState> => {
      const nonce = randomUUID();
      writeFileSync(controlFile, JSON.stringify({ command, nonce }));
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
    await waitForWorkbenchWindow(app, viewTimeout);
    await resizeWindow(app, page, 1440, 900);
    recordBootstrapStage("ready");
    return {
      app: runningApp,
      page,
      async executeCommand(command, timeout) {
        await focusWindow(runningApp, page);
        await runAcceptanceCommand(command, timeout);
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
      },
      async inspectActiveNotebook() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectActiveNotebook",
        );
        return state.result as ActiveNotebookSnapshot | undefined;
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
      async resetWorkbenchUI() {
        const state = await runAcceptanceCommand("postgresql-workbench.acceptance.resetWorkbench");
        const result = state.result as { remainingTabCount?: unknown } | undefined;
        if (result?.remainingTabCount !== 0) {
          throw new Error(
            `VS Code still exposes ${String(result?.remainingTabCount)} editor tabs after the acceptance reset`,
          );
        }
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
