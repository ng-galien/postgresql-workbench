import editorStyles from "../../../packages/editor/src/editor.css";
import { MonacoSqlEditor } from "../../../packages/editor/src/MonacoSqlEditor.js";
import { sqlEditorPageRuntime } from "../../../packages/editor/src/pageRuntime.js";
import { SqlEditorRuntime } from "../../../packages/editor/src/runtime.js";
import type {
  DataViewRequest,
  DataViewResponse,
} from "../../../packages/rows/src/dataView/dataViewProtocol.js";
import { DataViewApp } from "../../../packages/views/src/dataView/DataViewApp.js";
import dataViewStyles from "../../../packages/views/src/dataView/dataView.css";
import { resultViewStyles } from "../../../packages/views/src/results/resultStyles.js";
import { mountWebview, webviewMessaging } from "../webviews/webviewPage.js";

const messaging = webviewMessaging<DataViewRequest, DataViewResponse>();
const runtime = sqlEditorPageRuntime();

mountWebview(
  <>
    <SqlEditorRuntime {...runtime} />
    <DataViewApp messaging={messaging} Editor={MonacoSqlEditor} />
  </>,
  `${editorStyles}\n${resultViewStyles}\n${dataViewStyles}`,
);
