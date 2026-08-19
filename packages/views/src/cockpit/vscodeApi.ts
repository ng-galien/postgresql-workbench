import { webviewMessaging } from "../webviewPage.js";
import type { WorkbenchGraphHostMessage, WorkbenchGraphWebviewMessage } from "./protocol.js";

/**
 * How the Cockpit talks to the Extension Host: `post` sends, `subscribeToHost` hands out what
 * comes back and returns how to stop listening.
 */
export const { post, subscribe: subscribeToHost } = webviewMessaging<
  WorkbenchGraphWebviewMessage,
  WorkbenchGraphHostMessage
>();
