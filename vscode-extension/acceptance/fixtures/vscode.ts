import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron } from "playwright";

const extensionRoot = resolve(__dirname, "../..");
const workspace = resolve(extensionRoot, "test-workspace");
const artifactsRoot = resolve(extensionRoot, "test-results", "acceptance-worker");

export interface VSCodeInstance {
  app: ElectronApplication;
  page: Page;
  dispose(): Promise<void>;
}

export async function launchVSCode(): Promise<VSCodeInstance> {
  const version = process.env.PGWB_ACCEPTANCE_VSCODE_VERSION ?? "stable";
  const executablePath = await downloadAndUnzipVSCode(version);
  const profileRoot = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pgwb-acceptance-"),
  );
  const userDataDir = join(profileRoot, "user");
  const extensionsDir = join(profileRoot, "extensions");
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

  const app = await electron.launch({
    executablePath,
    args: [
      "--disable-gpu-sandbox",
      "--disable-updates",
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 30_000 });
  await app.context().tracing.start({ screenshots: true, snapshots: true });

  return {
    app,
    page,
    async dispose() {
      await app
        .context()
        .tracing.stop({ path: join(artifactsRoot, "trace.zip") })
        .catch(() => {});
      await app.close().catch(() => undefined);
      rmSync(profileRoot, { recursive: true, force: true });
    },
  };
}
