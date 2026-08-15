import { randomUUID } from "node:crypto";
import { rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as vscode from "vscode";

const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";
const SAVE_ALL_COMMAND = "workbench.action.files.saveAll";
const QUICK_OPEN_COMMAND = "workbench.action.quickOpen";
const FOCUS_TESTING_COMMAND = "workbench.view.testing.focus";
const RUN_ALL_TESTS_COMMAND = "testing.runAll";
const COVERAGE_ALL_TESTS_COMMAND = "testing.coverageAll";
const OPEN_COVERAGE_COMMAND = "testing.openCoverage";
const TOGGLE_INLINE_COVERAGE_COMMAND = "testing.toggleInlineCoverage";
const DEBUG_CONTINUE_COMMAND = "workbench.action.debug.continue";
const DEBUG_STEP_INTO_COMMAND = "workbench.action.debug.stepInto";
const DEBUG_STEP_OVER_COMMAND = "workbench.action.debug.stepOver";
const FOCUS_WORKBENCH_COMMAND = "postgresql-workbench-connections.focus";
const INSPECT_TESTING_STATE_COMMAND = "postgresql-workbench.acceptance.inspectTestingState";
const INSPECT_ACTIVE_NOTEBOOK_COMMAND = "postgresql-workbench.acceptance.inspectActiveNotebook";
const INSPECT_ACTIVE_TEXT_EDITOR_COMMAND =
  "postgresql-workbench.acceptance.inspectActiveTextEditor";
const INSPECT_DEBUG_STATE_COMMAND = "postgresql-workbench.acceptance.inspectDebugState";
const REMOVE_SERVER_COMMAND = "postgresql-workbench.acceptance.removeServer";
const RESET_WORKBENCH_COMMAND = "postgresql-workbench.acceptance.resetWorkbench";
const OPEN_WORKSPACE_FILE_COMMAND = "postgresql-workbench.acceptance.openWorkspaceFile";
const OPEN_SQL_DOCUMENT_COMMAND = "postgresql-workbench.acceptance.openSqlDocument";
const ACCEPTANCE_COMMANDS = new Set([
  RELOAD_WINDOW_COMMAND,
  SAVE_ALL_COMMAND,
  QUICK_OPEN_COMMAND,
  FOCUS_TESTING_COMMAND,
  RUN_ALL_TESTS_COMMAND,
  COVERAGE_ALL_TESTS_COMMAND,
  OPEN_COVERAGE_COMMAND,
  TOGGLE_INLINE_COVERAGE_COMMAND,
  DEBUG_CONTINUE_COMMAND,
  DEBUG_STEP_INTO_COMMAND,
  DEBUG_STEP_OVER_COMMAND,
  FOCUS_WORKBENCH_COMMAND,
  INSPECT_TESTING_STATE_COMMAND,
  INSPECT_ACTIVE_NOTEBOOK_COMMAND,
  INSPECT_ACTIVE_TEXT_EDITOR_COMMAND,
  INSPECT_DEBUG_STATE_COMMAND,
  REMOVE_SERVER_COMMAND,
  RESET_WORKBENCH_COMMAND,
  OPEN_WORKSPACE_FILE_COMMAND,
  OPEN_SQL_DOCUMENT_COMMAND,
]);

export interface AcceptanceControl extends vscode.Disposable {
  markReady(): void;
}

export interface AcceptanceControlOptions {
  inspectDebugState(): unknown;
  inspectTestingState(): unknown;
  removeServer(id: string): Promise<void> | void;
  resetWorkbench(): Promise<void> | void;
}

export function registerAcceptanceControl(
  context: vscode.ExtensionContext,
  options: AcceptanceControlOptions,
): AcceptanceControl | undefined {
  const controlFile =
    process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE ??
    vscode.workspace.getConfiguration("postgresql-workbench").get<string>("acceptanceControlFile");
  if (!controlFile || context.extensionMode === vscode.ExtensionMode.Production) return undefined;
  const readyFile = `${controlFile}.ready`;
  const activationId = randomUUID();
  const acceptanceSqlDocuments = new Set<string>();

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
          arguments?: unknown;
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
        if (instruction.command === INSPECT_ACTIVE_TEXT_EDITOR_COMMAND) {
          const editor = vscode.window.activeTextEditor;
          markReady(
            instruction.nonce,
            editor && {
              languageId: editor.document.languageId,
              text: editor.document.getText(),
              uri: editor.document.uri.toString(),
            },
          );
          return;
        }
        if (instruction.command === INSPECT_DEBUG_STATE_COMMAND) {
          markReady(instruction.nonce, options.inspectDebugState());
          return;
        }
        if (instruction.command === INSPECT_TESTING_STATE_COMMAND) {
          markReady(instruction.nonce, options.inspectTestingState());
          return;
        }
        if (instruction.command === REMOVE_SERVER_COMMAND) {
          const serverId = Array.isArray(instruction.arguments)
            ? instruction.arguments[0]
            : undefined;
          if (typeof serverId !== "string" || serverId.length === 0) {
            throw new Error("Remove server requires a non-empty server id");
          }
          await options.removeServer(serverId);
          markReady(instruction.nonce);
          return;
        }
        if (instruction.command === RESET_WORKBENCH_COMMAND) {
          await vscode.commands.executeCommand(SAVE_ALL_COMMAND);
          await options.resetWorkbench();
          const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
          if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, false);
          await deleteAcceptanceSqlDocuments(acceptanceSqlDocuments);
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
        if (instruction.command === OPEN_WORKSPACE_FILE_COMMAND) {
          const fileName = Array.isArray(instruction.arguments)
            ? instruction.arguments[0]
            : undefined;
          if (typeof fileName !== "string" || fileName.length === 0) {
            throw new Error("Open workspace file requires a non-empty file name");
          }
          const matches = await vscode.workspace.findFiles(`**/${fileName}`, undefined, 2);
          if (matches.length !== 1) {
            throw new Error(
              `Expected one workspace file named ${fileName}, found ${matches.length}`,
            );
          }
          await vscode.window.showTextDocument(matches[0]);
          markReady(instruction.nonce);
          return;
        }
        if (instruction.command === OPEN_SQL_DOCUMENT_COMMAND) {
          const content = Array.isArray(instruction.arguments)
            ? instruction.arguments[0]
            : undefined;
          if (typeof content !== "string") {
            throw new Error("Open SQL document requires string content");
          }
          const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.globalStorageUri;
          const directory = vscode.Uri.joinPath(root, ".postgresql-workbench-acceptance");
          await vscode.workspace.fs.createDirectory(directory);
          const uri = vscode.Uri.joinPath(directory, `authoring-${randomUUID()}.sql`);
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
          acceptanceSqlDocuments.add(uri.toString());
          await vscode.window.showTextDocument(uri);
          markReady(instruction.nonce);
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
      void deleteAcceptanceSqlDocuments(acceptanceSqlDocuments);
    },
  };
}

async function deleteAcceptanceSqlDocuments(uris: Set<string>): Promise<void> {
  const directories = new Set<string>();
  await Promise.all(
    [...uris].map(async (value) => {
      const uri = vscode.Uri.parse(value);
      directories.add(vscode.Uri.joinPath(uri, "..").toString());
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // Acceptance cleanup is best-effort after the editor has already closed.
      }
      uris.delete(value);
    }),
  );
  await Promise.all(
    [...directories].map(async (value) => {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.parse(value));
      } catch {
        // The directory can already be gone after an interrupted acceptance run.
      }
    }),
  );
}
