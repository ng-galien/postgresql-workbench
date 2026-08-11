import { unwatchFile, watchFile } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as vscode from "vscode";

const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";

export function registerAcceptanceControl(
  context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
  const controlFile = process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
  if (!controlFile || context.extensionMode === vscode.ExtensionMode.Production) return undefined;

  let pending = Promise.resolve();
  const consume = () => {
    pending = pending
      .then(async () => {
        const instruction = JSON.parse(await readFile(controlFile, "utf8")) as {
          command?: unknown;
        };
        await rm(controlFile, { force: true });
        if (instruction.command !== RELOAD_WINDOW_COMMAND) {
          throw new Error(`Unsupported acceptance command: ${String(instruction.command)}`);
        }
        await vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: acceptance-only bridge failures must remain visible in extension-host logs.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(error);
      });
  };
  watchFile(controlFile, { interval: 50 }, consume);
  return new vscode.Disposable(() => unwatchFile(controlFile, consume));
}
