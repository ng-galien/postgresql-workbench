import { randomUUID } from "node:crypto";
import { rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as vscode from "vscode";

const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";
const QUICK_OPEN_COMMAND = "workbench.action.quickOpen";
const FOCUS_WORKBENCH_COMMAND = "postgresql-workbench-connections.focus";
const INSPECT_ACTIVE_NOTEBOOK_COMMAND = "postgresql-workbench.acceptance.inspectActiveNotebook";
const INSPECT_DEBUG_STATE_COMMAND = "postgresql-workbench.acceptance.inspectDebugState";
const RESET_WORKBENCH_COMMAND = "postgresql-workbench.acceptance.resetWorkbench";
const ACCEPTANCE_COMMANDS = new Set([
  RELOAD_WINDOW_COMMAND,
  QUICK_OPEN_COMMAND,
  FOCUS_WORKBENCH_COMMAND,
  INSPECT_ACTIVE_NOTEBOOK_COMMAND,
  INSPECT_DEBUG_STATE_COMMAND,
  RESET_WORKBENCH_COMMAND,
]);

export interface AcceptanceControl extends vscode.Disposable {
  markReady(): void;
}

export interface AcceptanceControlOptions {
  inspectDebugState(): unknown;
  resetWorkbench(): Promise<void> | void;
}

export function registerAcceptanceControl(
  context: vscode.ExtensionContext,
  options: AcceptanceControlOptions,
): AcceptanceControl | undefined {
  const controlFile = process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
  if (!controlFile || context.extensionMode === vscode.ExtensionMode.Production) return undefined;
  const readyFile = `${controlFile}.ready`;
  const activationId = randomUUID();

  const markReady = (commandNonce?: string, result?: unknown) => {
    writeFileSync(
      readyFile,
      JSON.stringify({ activationId, commandNonce, result, status: "ready" }),
    );
  };

  let pending = Promise.resolve();
  const consume = () => {
    pending = pending
      .then(async () => {
        const instruction = JSON.parse(await readFile(controlFile, "utf8")) as {
          command?: unknown;
          nonce?: unknown;
        };
        await rm(controlFile, { force: true });
        if (
          typeof instruction.command !== "string" ||
          !ACCEPTANCE_COMMANDS.has(instruction.command)
        ) {
          throw new Error(`Unsupported acceptance command: ${String(instruction.command)}`);
        }
        if (typeof instruction.nonce !== "string") {
          throw new Error("Acceptance command is missing its nonce");
        }
        if (instruction.command === INSPECT_ACTIVE_NOTEBOOK_COMMAND) {
          const notebook = vscode.window.activeNotebookEditor?.notebook;
          markReady(
            instruction.nonce,
            notebook && {
              cells: [...notebook.getCells()].map((cell) => ({
                kind:
                  cell.kind === vscode.NotebookCellKind.Markup
                    ? ("markup" as const)
                    : ("code" as const),
                languageId: cell.document.languageId,
                outputs: cell.outputs.flatMap((output) => output.items.map((item) => item.mime)),
                outputGroups: cell.outputs.map((output) => output.items.map((item) => item.mime)),
                text: cell.document.getText(),
              })),
              notebookType: notebook.notebookType,
              uri: notebook.uri.toString(),
            },
          );
          return;
        }
        if (instruction.command === INSPECT_DEBUG_STATE_COMMAND) {
          markReady(instruction.nonce, options.inspectDebugState());
          return;
        }
        if (instruction.command === RESET_WORKBENCH_COMMAND) {
          await vscode.commands.executeCommand("workbench.action.files.saveAll");
          await options.resetWorkbench();
          const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
          if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, false);
          await vscode.commands.executeCommand(FOCUS_WORKBENCH_COMMAND);
          markReady(instruction.nonce, {
            closedTabCount: tabs.length,
            remainingTabCount: vscode.window.tabGroups.all.reduce(
              (count, group) => count + group.tabs.length,
              0,
            ),
          });
          return;
        }
        await vscode.commands.executeCommand(instruction.command);
        if (instruction.command !== RELOAD_WINDOW_COMMAND) markReady(instruction.nonce);
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: acceptance-only bridge failures must remain visible in extension-host logs.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(error);
      });
  };
  watchFile(controlFile, { interval: 50 }, consume);
  return {
    markReady() {
      markReady();
    },
    dispose() {
      unwatchFile(controlFile, consume);
      rmSync(readyFile, { force: true });
    },
  };
}
