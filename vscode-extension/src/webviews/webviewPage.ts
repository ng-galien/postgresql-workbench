import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ViewMessaging } from "../../../packages/views/src/messaging.js";
import { vscode } from "./vscodeApi.js";

/** Adapts the VS Code webview message channel to the host-neutral view port. */
export function webviewMessaging<Request, Response>(): ViewMessaging<Request, Response> {
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

/** Mounts one React view into the DOM owned by a VS Code webview page. */
export function mountWebview(view: ReactNode, styles?: string): void {
  if (styles !== undefined) {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
  }
  const container = document.getElementById("root");
  if (container) createRoot(container).render(view);
}
