import "../../../packages/presentation/src/defaultTheme.css";
import "../../../packages/editor/src/editor.css";
import { ensureEditorScheme } from "../../../packages/editor/src/fileSystem.js";
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
import { CODE_MONIKER_URI_SCHEME } from "../sources/uri.js";
import { mountWebview, webviewMessaging } from "../webviews/webviewPage.js";

ensureEditorScheme(CODE_MONIKER_URI_SCHEME);
const runtime = sqlEditorPageRuntime();
const messaging = webviewMessaging<WorkbenchGraphWebviewMessage, WorkbenchGraphHostMessage>();

mountWebview(
  <>
    <SqlEditorRuntime {...runtime} />
    <App messaging={messaging} Editor={MonacoSqlEditor} />
  </>,
);
