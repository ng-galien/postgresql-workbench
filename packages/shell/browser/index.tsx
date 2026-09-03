import { createRoot } from "react-dom/client";
import editorStyles from "../../editor/src/editor.css";
import { MonacoSqlEditor } from "../../editor/src/MonacoSqlEditor.js";
import { SqlEditorRuntime } from "../../editor/src/runtime.js";
import type {
  DataViewRequest,
  DataViewResponse,
} from "../../rows/src/dataView/dataViewProtocol.js";
import { DataViewApp, type DataViewMessaging } from "../../views/src/dataView/DataViewApp.js";
import dataViewStyles from "../../views/src/dataView/dataView.css";
import navigationStyles from "../../views/src/navigation/workbenchNavigation.css";
import modalStyles from "../../views/src/results/modal.css";
import { resultViewStyles } from "../../views/src/results/resultStyles.js";
import { languageServerUrl, pageBridge, preparePage } from "./bridge.js";
import { ShellPage } from "./ShellPage.js";
import shellPageStyles from "./shellPage.css";

/**
 * The Data View, in a browser, driven by the real Extension Host logic running behind an HTTP
 * bridge: PostgreSQL answers the rows, Code Moniker parses the SQL, the composition engine plans
 * the joins. Only VS Code is missing, which is the point — everything here can be looked at, and
 * everything here is what the product does.
 */
const bridge = pageBridge<DataViewRequest, DataViewResponse>("/data-view");

const messaging: DataViewMessaging = {
  post(request: DataViewRequest) {
    /*
     * Following an address is the host's answer to give, and here the host is this page: the
     * engine runs on the other side of a fetch, where there is no browser to open a tab with.
     * Answered on the spot, inside the click that asked, so the browser sees a gesture and not a
     * popup arriving out of nowhere.
     */
    if (request.type === "follow-link") {
      /* Recorded where a journey can read it: what the harness owes is the address it was given. */
      document.body.dataset.followedLink = request.href;
      window.open(request.href, "_blank", "noopener");
      return;
    }
    bridge.post(request);
  },
  subscribe: bridge.subscribe,
};

const container = preparePage(
  `${navigationStyles}\n${shellPageStyles}\n${resultViewStyles}\n${editorStyles}\n${modalStyles}\n${dataViewStyles}`,
);
if (container)
  createRoot(container).render(
    <SqlEditorRuntime languageServerUrl={languageServerUrl()} editorWorkerUrl="/editor.worker.js">
      <ShellPage active="data-view">
        <DataViewApp messaging={messaging} Editor={MonacoSqlEditor} />
      </ShellPage>
    </SqlEditorRuntime>,
  );
