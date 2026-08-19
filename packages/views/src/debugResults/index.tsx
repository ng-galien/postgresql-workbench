import { resultViewStyles } from "../results/resultStyles.js";
import { mountWebview, webviewMessaging } from "../webviewPage.js";
import { DebugResultsApp, useDebugResultsState } from "./DebugResultsApp.js";
import debugResultsStyles from "./debugResults.css";
import type { DebugResultsRequest, DebugResultsResponse } from "./protocol.js";

const messaging = webviewMessaging<DebugResultsRequest, DebugResultsResponse>();

function DebugResults() {
  return <DebugResultsApp post={messaging.post} state={useDebugResultsState(messaging)} />;
}

mountWebview(<DebugResults />, `${resultViewStyles}\n${debugResultsStyles}`);
