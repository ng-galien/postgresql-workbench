import {
  DebugResultsApp,
  useDebugResultsState,
} from "../../../packages/views/src/debugResults/DebugResultsApp.js";
import debugResultsStyles from "../../../packages/views/src/debugResults/debugResults.css";
import type {
  DebugResultsRequest,
  DebugResultsResponse,
} from "../../../packages/views/src/debugResults/protocol.js";
import { resultViewStyles } from "../../../packages/views/src/results/resultStyles.js";
import { mountWebview, webviewMessaging } from "../webviews/webviewPage.js";

const messaging = webviewMessaging<DebugResultsRequest, DebugResultsResponse>();

function DebugResults() {
  return <DebugResultsApp messaging={messaging} state={useDebugResultsState(messaging)} />;
}

mountWebview(<DebugResults />, `${resultViewStyles}\n${debugResultsStyles}`);
