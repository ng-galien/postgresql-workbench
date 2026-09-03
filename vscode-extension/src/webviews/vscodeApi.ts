export interface WebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): WebviewApi;

/** The page's single VS Code handle: acquiring it twice throws, so every entrypoint reads this. */
export const vscode: WebviewApi = acquireVsCodeApi();
