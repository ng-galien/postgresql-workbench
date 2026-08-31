import "../../../packages/presentation/src/defaultTheme.css";
import "../../../packages/editor/src/editor.css";
import { MonacoSqlEditor } from "../../../packages/editor/src/MonacoSqlEditor.js";
import { sqlEditorPageRuntime } from "../../../packages/editor/src/pageRuntime.js";
import { SqlEditorRuntime } from "../../../packages/editor/src/runtime.js";
import { App } from "../../../packages/views/src/cockpit/components/App.js";
import type {
  WorkbenchGraphHostMessage,
  WorkbenchGraphWebviewMessage,
} from "../../../packages/views/src/cockpit/protocol.js";
import "../../../packages/views/src/cockpit/styles.css";
import "@xyflow/react/dist/style.css";
import { mountWebview, webviewMessaging } from "../webviews/webviewPage.js";

const runtime = sqlEditorPageRuntime();
const messaging = webviewMessaging<WorkbenchGraphWebviewMessage, WorkbenchGraphHostMessage>();

mountWebview(
  <>
    <SqlEditorRuntime {...runtime} />
    <App messaging={messaging} Editor={MonacoSqlEditor} />
  </>,
);
