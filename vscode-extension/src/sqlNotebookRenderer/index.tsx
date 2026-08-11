import { createRoot, type Root } from "react-dom/client";
import type {
  SqlNotebookOutputPayload,
  SqlNotebookRendererRequest,
  SqlNotebookRendererResponse,
  SqlNotebookResultPayload,
} from "../sqlNotebookModel.js";
import { SqlErrorView } from "./SqlErrorView.js";
import { type SqlResultMessaging, SqlResultView } from "./SqlResultView.js";
import styles from "./styles.css";

interface RendererOutputItem {
  id: string;
  json(): unknown;
}

interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement): void;
  disposeOutputItem(outputId?: string): void;
}

interface RendererContext {
  postMessage?(message: SqlNotebookRendererRequest): void;
  onDidReceiveMessage?(listener: (message: SqlNotebookRendererResponse) => void): {
    dispose(): void;
  };
}

export function activate(context: RendererContext = {}): RendererApi {
  const roots = new Map<string, Root>();
  const listeners = new Set<(message: SqlNotebookRendererResponse) => void>();
  const messageSubscription = context.onDidReceiveMessage?.((message) => {
    for (const listener of listeners) listener(message);
  });
  const messaging: SqlResultMessaging | undefined = context.postMessage
    ? {
        postMessage: (message) => context.postMessage?.(message),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }
    : undefined;
  return {
    renderOutputItem(outputItem, element) {
      roots.get(outputItem.id)?.unmount();
      const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
      shadow.replaceChildren();

      const style = document.createElement("style");
      style.textContent = styles;
      const mount = document.createElement("div");
      shadow.append(style, mount);

      const root = createRoot(mount);
      roots.set(outputItem.id, root);
      const payload = outputItem.json() as SqlNotebookOutputPayload;
      root.render(
        "type" in payload && payload.type === "error" ? (
          <SqlErrorView payload={payload} />
        ) : (
          <SqlResultView payload={payload as SqlNotebookResultPayload} messaging={messaging} />
        ),
      );
    },
    disposeOutputItem(outputId) {
      if (outputId) {
        roots.get(outputId)?.unmount();
        roots.delete(outputId);
        return;
      }
      for (const root of roots.values()) root.unmount();
      roots.clear();
      listeners.clear();
      messageSubscription?.dispose();
    },
  };
}
