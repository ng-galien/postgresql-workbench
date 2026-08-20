import modalStyles from "../results/modal.css";
import { resultViewStyles } from "../results/resultStyles.js";
import { postgresSourceStyles } from "../source/sourceStyles.js";
import { mountWebview, webviewMessaging } from "../webviewPage.js";
import { DataViewApp } from "./DataViewApp.js";
import dataViewStyles from "./dataView.css";
import type { DataViewRequest, DataViewResponse } from "./protocol.js";

const messaging = webviewMessaging<DataViewRequest, DataViewResponse>();

mountWebview(
  <DataViewApp messaging={messaging} />,
  `${resultViewStyles}\n${postgresSourceStyles}\n${modalStyles}\n${dataViewStyles}`,
);
