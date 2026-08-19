import { createRoot } from "react-dom/client";
import { codicons } from "../results/codicons.js";
import iconButtonStyles from "../results/iconButton.css";
import gridStyles from "../results/styles.css";
import { DataViewApp, type DataViewMessaging } from "./DataViewApp.js";
import dataViewStyles from "./dataView.css";
import type { DataViewRequest, DataViewResponse } from "./protocol.js";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const listeners = new Set<(message: DataViewResponse) => void>();
window.addEventListener("message", (event: MessageEvent<DataViewResponse>) => {
  for (const listener of listeners) listener(event.data);
});

const messaging: DataViewMessaging = {
  post(message: DataViewRequest) {
    vscode.postMessage(message);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const style = document.createElement("style");
style.textContent = `${codicons}\n${gridStyles}\n${iconButtonStyles}\n${dataViewStyles}`;
document.head.append(style);

const container = document.getElementById("root");
if (container) createRoot(container).render(<DataViewApp messaging={messaging} />);
