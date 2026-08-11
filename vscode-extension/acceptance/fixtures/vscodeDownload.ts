import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const preparedRuntimeFile = resolve(__dirname, "../../test-results/acceptance-runtime.json");

interface PreparedAcceptanceRuntime {
  executablePath: string;
  version: string;
}

async function downloadAcceptanceVSCode(): Promise<PreparedAcceptanceRuntime> {
  const version = process.env.PGWB_ACCEPTANCE_VSCODE_VERSION ?? "stable";
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return {
        executablePath: await downloadAndUnzipVSCode({ version, timeout: 30_000 }),
        version,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }

  throw new Error(`Unable to prepare VS Code ${version} after 3 attempts`, {
    cause: lastError,
  });
}

export async function prepareAcceptanceVSCode(): Promise<void> {
  const runtime = await downloadAcceptanceVSCode();
  mkdirSync(dirname(preparedRuntimeFile), { recursive: true });
  writeFileSync(preparedRuntimeFile, JSON.stringify(runtime));
}

export function preparedAcceptanceVSCode(): PreparedAcceptanceRuntime {
  if (!existsSync(preparedRuntimeFile)) {
    throw new Error(
      "VS Code was not prepared by Playwright global setup before the acceptance worker started",
    );
  }
  const runtime = JSON.parse(
    readFileSync(preparedRuntimeFile, "utf8"),
  ) as PreparedAcceptanceRuntime;
  if (!runtime.executablePath || !existsSync(runtime.executablePath)) {
    throw new Error(
      `Prepared VS Code ${runtime.version} is unavailable at ${runtime.executablePath}`,
    );
  }
  return runtime;
}
