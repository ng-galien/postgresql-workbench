import defaultThemeStyles from "../../../packages/presentation/src/defaultTheme.css";
import { ConnectionsApp } from "../../../packages/views/src/connections/ConnectionsApp.js";
import connectionsStyles from "../../../packages/views/src/connections/connections.css";
import type {
  ConnectionsPageRequest,
  ConnectionsPageResponse,
} from "../../../packages/views/src/connections/protocol.js";
import { mountWebview, webviewMessaging } from "../webviews/webviewPage.js";

const messaging = webviewMessaging<ConnectionsPageRequest, ConnectionsPageResponse>();

mountWebview(
  <ConnectionsApp messaging={messaging} />,
  `${defaultThemeStyles}\n${connectionsStyles}`,
);
