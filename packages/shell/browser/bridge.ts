import type { ViewMessaging } from "../../views/src/messaging.js";

/**
 * The wire between a shell page and its host: requests go by POST, responses come back on an
 * event stream, and a rebuild reloads the page. Every page of the shell speaks through this, so a
 * new view is a mount and two endpoints, never a second wiring.
 */
export function pageBridge<Request, Response>(base: string): ViewMessaging<Request, Response> {
  const listeners = new Set<(response: Response) => void>();
  const events = new EventSource(`${base}/responses`);
  const pending: Request[] = [];
  const send = (request: Request) =>
    fetch(`${base}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  events.onopen = () => {
    for (const request of pending.splice(0)) void send(request);
  };
  events.addEventListener("reload", () => window.location.reload());
  events.onmessage = (event) => {
    const response = JSON.parse(event.data) as Response;
    for (const listener of listeners) listener(response);
  };
  return {
    post(request: Request) {
      if (events.readyState === EventSource.OPEN) void send(request);
      else pending.push(request);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The page shell every view mounts into: styles inlined and a full-height root. */
export function preparePage(styles: string): HTMLElement | null {
  const style = document.createElement("style");
  style.textContent = `${styles}
  html, body { height: 100%; margin: 0; overflow: hidden;
    background: var(--pgw-canvas-background); color: var(--pgw-text);
    font-family: var(--pgw-ui-font-family); font-size: var(--pgw-ui-font-size); }
  #root { height: 100%; }`;
  document.head.append(style);
  return document.getElementById("root");
}

export function languageServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sql-language-server`;
}
