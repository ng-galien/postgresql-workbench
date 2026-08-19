import type { WorkbenchGraphWebviewMessage } from "./protocol.js";

interface WebviewApi {
  postMessage(message: WorkbenchGraphWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): WebviewApi;

export const vscode = acquireVsCodeApi();
