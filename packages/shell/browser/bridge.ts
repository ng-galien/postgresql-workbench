import type { WebviewMessaging } from "../../views/src/webviewPage.js";

/**
 * The wire between a shell page and its host: requests go by POST, responses come back on an
 * event stream, and a rebuild reloads the page. Every page of the shell speaks through this, so a
 * new view is a mount and two endpoints, never a second wiring.
 */
export function pageBridge<Request, Response>(base: string): WebviewMessaging<Request, Response> {
  const listeners = new Set<(response: Response) => void>();
  const events = new EventSource(`${base}/responses`);
  events.addEventListener("reload", () => window.location.reload());
  events.onmessage = (event) => {
    const response = JSON.parse(event.data) as Response;
    for (const listener of listeners) listener(response);
  };
  return {
    post(request: Request) {
      void fetch(`${base}/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The page shell every view mounts into: dark theme marked, styles inlined, full-height root. */
export function preparePage(styles: string): HTMLElement | null {
  document.body.classList.add("vscode-dark");
  const style = document.createElement("style");
  style.textContent = `${styles}
  html, body { height: 100%; margin: 0; overflow: hidden;
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #root { height: 100%; }`;
  document.head.append(style);
  return document.getElementById("root");
}
