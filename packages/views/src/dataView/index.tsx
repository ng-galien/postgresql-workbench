import codiconStyles from "@vscode/codicons/dist/codicon.css";
import codiconFont from "@vscode/codicons/dist/codicon.ttf";
import { createRoot } from "react-dom/client";
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
// The codicon stylesheet references its font by relative URL; embed the font instead.
const codicons = codiconStyles.replace(
  /@font-face\s*\{[^}]*\}/u,
  `@font-face { font-family: "codicon"; src: url(${codiconFont}) format("truetype"); }`,
);
style.textContent = `${codicons}\n${gridStyles}\n${dataViewStyles}`;
document.head.append(style);

const container = document.getElementById("root");
if (container) createRoot(container).render(<DataViewApp messaging={messaging} />);
