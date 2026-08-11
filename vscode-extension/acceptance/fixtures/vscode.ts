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
  status: "ready";
}

function readReadyState(path: string): ExtensionReadyState | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionReadyState>;
    if (state.status === "ready" && typeof state.activationId === "string") {
      return state as ExtensionReadyState;
    }
  } catch {
    // The extension writes this file atomically enough for the next polling iteration to retry.
  }
  return undefined;
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
  resizeWindow(width: number, height: number): Promise<void>;
  dispose(): Promise<void>;
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
    const page = await app.firstWindow({ timeout: 30_000 });
    await page.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 30_000 });
    let ready = await waitForActivation(
      readyFile,
      undefined,
      30_000,
      "PostgreSQL Workbench extension activation",
    );
    await resizeWindow(app, page, 1440, 900);
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;

    const runningApp = app;
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
