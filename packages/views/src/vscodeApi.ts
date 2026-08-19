export interface WebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): WebviewApi;

/** The page's single VS Code handle: acquiring it twice throws, so every view reads this one. */
export const vscode: WebviewApi = acquireVsCodeApi();
