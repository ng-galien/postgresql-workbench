import { createRoot } from "react-dom/client";
import { codicons } from "../results/codicons.js";
import iconButtonStyles from "../results/iconButton.css";
import gridStyles from "../results/styles.css";
import { DebugResultsApp, useDebugResultsState } from "./DebugResultsApp.js";
import debugResultsStyles from "./debugResults.css";
import type { DebugResultsRequest } from "./protocol.js";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: DebugResultsRequest) => vscode.postMessage(message);

function DebugResults() {
  return <DebugResultsApp post={post} state={useDebugResultsState(post)} />;
}

const style = document.createElement("style");
style.textContent = `${codicons}\n${gridStyles}\n${iconButtonStyles}\n${debugResultsStyles}`;
document.head.append(style);

const container = document.getElementById("root");
if (container) createRoot(container).render(<DebugResults />);
