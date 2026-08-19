import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vscode } from "./vscodeApi.js";

/** What a webview page sends the Extension Host, and what it hands back to whoever listens. */
export interface WebviewMessaging<Request, Response> {
  post(message: Request): void;
  subscribe(listener: (message: Response) => void): () => void;
}

/** The page's messaging: one `message` listener on the window, however many views subscribe. */
export function webviewMessaging<Request, Response>(): WebviewMessaging<Request, Response> {
  const listeners = new Set<(message: Response) => void>();
  window.addEventListener("message", (event: MessageEvent<Response>) => {
    for (const listener of listeners) listener(event.data);
  });
  return {
    post(message: Request) {
      vscode.postMessage(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Mounts the view into the `#root` of the page shell. `styles` is for a bundle that carries its
 * stylesheets inline; a page whose shell links its own stylesheet passes none.
 */
export function mountWebview(view: ReactNode, styles?: string): void {
  if (styles !== undefined) {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
  }
  const container = document.getElementById("root");
  if (container) createRoot(container).render(view);
}
