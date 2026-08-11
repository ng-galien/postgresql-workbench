import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { preparedAcceptanceVSCode } from "./vscodeDownload";

const extensionRoot = resolve(__dirname, "../..");
const workspace = resolve(extensionRoot, "test-workspace");
const artifactsRoot = resolve(extensionRoot, "test-results", "acceptance-worker");

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
  focused: boolean;
  id: number;
  title: string;
  url: string;
  visible: boolean;
}

async function electronWindowState(
  app: ElectronApplication,
  page: Page,
): Promise<ElectronWindowState> {
  const browserWindow = await app.browserWindow(page);
  try {
    return await browserWindow.evaluate((window) => {
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
  } finally {
    await browserWindow.dispose();
  }
}

async function waitForVSCodeWindow(app: ElectronApplication, timeout: number): Promise<Page> {
  const deadline = Date.now() + timeout;
  let lastStates: ElectronWindowState[] = [];
  while (Date.now() < deadline) {
    const candidates: Array<{ page: Page; state: ElectronWindowState }> = [];
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      const state = await electronWindowState(app, page).catch(() => undefined);
      if (state?.visible) candidates.push({ page, state });
    }
    lastStates = candidates.map(({ state }) => state);
    const focused = candidates.find(({ state }) => state.focused);
    if (focused) return focused.page;
    candidates.sort((left, right) => right.state.area - left.state.area);
    if (candidates[0]) return candidates[0].page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `No visible VS Code Electron window appeared within ${timeout} ms. BrowserWindow states:\n${JSON.stringify(lastStates, null, 2)}`,
  );
}

async function waitForActivation(
  path: string,
  previousActivationId: string | undefined,
  timeout: number,
  description: string,
): Promise<ExtensionReadyState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = readReadyState(path);
    if (state && state.activationId !== previousActivationId) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} did not complete within ${timeout} ms`);
}

export interface VSCodeInstance {
  app: ElectronApplication;
  page: Page;
  executeInfrastructureCommand(command: "workbench.action.reloadWindow"): Promise<void>;
  inspectActiveNotebook(): Promise<ActiveNotebookSnapshot | undefined>;
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

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const browserWindow = await app.browserWindow(page);
  try {
    await browserWindow.evaluate((window, size) => window.setContentSize(size.width, size.height), {
      width,
      height,
    });
    await page.waitForFunction(
      (size) => window.innerWidth === size.width && window.innerHeight === size.height,
      { width, height },
      { timeout: 5_000 },
    );
  } finally {
    await browserWindow.dispose();
  }
}

export async function launchVSCode(): Promise<VSCodeInstance> {
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
        "--locale=en",
        "--new-window",
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
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
    let ready = await waitForActivation(
      readyFile,
      undefined,
      30_000,
      "PostgreSQL Workbench extension activation",
    );
    const page = await waitForVSCodeWindow(app, 30_000);
    await resizeWindow(app, page, 1440, 900);

    const runningApp = app;
    const runAcceptanceCommand = async (command: string): Promise<ExtensionReadyState> => {
      const nonce = randomUUID();
      writeFileSync(controlFile, JSON.stringify({ command, nonce }));
      ready = await waitForCommand(
        readyFile,
        ready.activationId,
        nonce,
        5_000,
        `VS Code command ${command}`,
      );
      return ready;
    };
    await runAcceptanceCommand("postgresql-workbench-connections.focus");
    return {
      app: runningApp,
      page,
      async executeInfrastructureCommand(command) {
        const previousActivationId = ready.activationId;
        writeFileSync(controlFile, JSON.stringify({ command, nonce: randomUUID() }));
        ready = await waitForActivation(
          readyFile,
          previousActivationId,
          30_000,
          `VS Code command ${command} and subsequent extension activation`,
        );
        await waitForVSCodeWindow(runningApp, 30_000);
      },
      async inspectActiveNotebook() {
        const state = await runAcceptanceCommand(
          "postgresql-workbench.acceptance.inspectActiveNotebook",
        );
        return state.result as ActiveNotebookSnapshot | undefined;
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
