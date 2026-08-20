import { createRoot } from "react-dom/client";
import { DataViewApp, type DataViewMessaging } from "../src/dataView/DataViewApp.js";
import dataViewStyles from "../src/dataView/dataView.css";
import type { DataViewRequest, DataViewResponse } from "../src/dataView/protocol.js";
import { resultViewStyles } from "../src/results/resultStyles.js";
import vscodeTheme from "./vscodeTheme.css";

/**
 * The Data View, in a browser, driven by the real Extension Host logic running behind an HTTP
 * bridge: PostgreSQL answers the rows, Code Moniker parses the SQL, the composition engine plans
 * the joins. Only VS Code is missing, which is the point — everything here can be looked at, and
 * everything here is what the product does.
 */
/** VS Code sizes the webview and paints behind it; here the page does. */
const HARNESS_STYLES = `
  html, body { height: 100%; margin: 0; overflow: hidden;
    background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #root { height: 100%; }
`;

const listeners = new Set<(response: DataViewResponse) => void>();

const messaging: DataViewMessaging = {
  post(request: DataViewRequest) {
    void fetch("/request", {
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

const events = new EventSource("/responses");
// The harness rebuilds on every change; the page takes the new bundle without being asked.
events.addEventListener("reload", () => window.location.reload());
events.onmessage = (event) => {
  const response = JSON.parse(event.data) as DataViewResponse;
  for (const listener of listeners) listener(response);
};

const style = document.createElement("style");
style.textContent = `${vscodeTheme}\n${resultViewStyles}\n${dataViewStyles}\n${HARNESS_STYLES}`;
document.head.append(style);

const container = document.getElementById("root");
if (container) createRoot(container).render(<DataViewApp messaging={messaging} />);
