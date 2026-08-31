import xyflowStyles from "@xyflow/react/dist/style.css";
import { createRoot } from "react-dom/client";
import editorStyles from "../../editor/src/editor.css";
import { MonacoSqlEditor } from "../../editor/src/MonacoSqlEditor.js";
import { SqlEditorRuntime } from "../../editor/src/runtime.js";
import defaultThemeStyles from "../../presentation/src/defaultTheme.css";
import { App } from "../../views/src/cockpit/components/App.js";
import type {
  WorkbenchGraphHostMessage,
  WorkbenchGraphWebviewMessage,
} from "../../views/src/cockpit/protocol.js";
import cockpitStyles from "../../views/src/cockpit/styles.css";
import navigationStyles from "../../views/src/navigation/workbenchNavigation.css";
import { languageServerUrl, pageBridge, preparePage } from "./bridge.js";
import { ShellPage } from "./ShellPage.js";
import shellPageStyles from "./shellPage.css";

const messaging = pageBridge<WorkbenchGraphWebviewMessage, WorkbenchGraphHostMessage>("/cockpit");
const container = preparePage(
  `${defaultThemeStyles}\n${navigationStyles}\n${shellPageStyles}\n${editorStyles}\n${xyflowStyles}\n${cockpitStyles}`,
);
if (container)
  createRoot(container).render(
    <SqlEditorRuntime languageServerUrl={languageServerUrl()} editorWorkerUrl="/editor.worker.js">
      <ShellPage active="cockpit">
        <App messaging={messaging} Editor={MonacoSqlEditor} />
      </ShellPage>
    </SqlEditorRuntime>,
  );
