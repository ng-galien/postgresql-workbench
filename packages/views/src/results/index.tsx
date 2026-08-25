import { createRoot, type Root } from "react-dom/client";
import type {
  SqlNotebookOutputPayload,
  SqlNotebookResultPayload,
  SqlStatementResultPayload,
} from "../../../rows/src/resultPayload.js";
import { notebookErrorPayload } from "../../../rows/src/resultPayload.js";
import { registerCodiconFont } from "./codicons.js";
import type { SqlNotebookRendererRequest, SqlNotebookRendererResponse } from "./payload.js";
import { resultViewStylesInShadowRoot } from "./resultStyles.js";
import { SqlErrorView } from "./SqlErrorView.js";
import { type SqlResultMessaging, SqlResultView } from "./SqlResultView.js";

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
      // The page this output belongs to — a notebook draws its outputs in a frame of its own.
      const page = element.ownerDocument;
      // Each output draws in its own shadow root; the font has to be in the page holding them.
      registerCodiconFont(page);
      roots.get(outputItem.id)?.unmount();
      const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
      shadow.replaceChildren();

      const style = page.createElement("style");
      style.textContent = resultViewStylesInShadowRoot;
      const mount = page.createElement("div");
      shadow.append(style, mount);

      const root = createRoot(mount);
      roots.set(outputItem.id, root);
      const payload = normalizeSqlNotebookOutputPayload(outputItem.json());
      root.render(
        "type" in payload && payload.type === "error" ? (
          <SqlErrorView payload={payload} messaging={messaging} />
        ) : (
          <SqlResultView payload={payload as SqlStatementResultPayload} messaging={messaging} />
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

/** Upgrade transient v2 rowsets when VS Code reloads a renderer over an existing cell output. */
export function normalizeSqlNotebookOutputPayload(value: unknown): SqlNotebookOutputPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unsupportedResultPayload();
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "error") return value as SqlNotebookOutputPayload;
  if (
    candidate.version === 3 &&
    (candidate.kind === "rowset" || candidate.kind === "command-report")
  ) {
    return value as SqlNotebookOutputPayload;
  }
  if (
    candidate.version === 2 &&
    candidate.kind === undefined &&
    Array.isArray(candidate.columns) &&
    Array.isArray(candidate.rows)
  ) {
    return {
      ...(value as Omit<SqlNotebookResultPayload, "version" | "kind">),
      version: 3,
      kind: "rowset",
    };
  }
  return unsupportedResultPayload();
}

function unsupportedResultPayload(): SqlNotebookOutputPayload {
  return notebookErrorPayload(
    "execution",
    "Unsupported SQL result",
    "Run the SQL cell again to refresh this result.",
  );
}
