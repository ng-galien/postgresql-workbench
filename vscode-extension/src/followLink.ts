import * as vscode from "vscode";
import { followableAddress, isFollowLinkRequest } from "../../packages/rows/src/followLink.js";

/**
 * Following an address a result cell holds, on behalf of the view that drew it.
 *
 * A webview cannot open one itself: its sandbox refuses a popup, and the host only answers a click
 * a person actually made — so a view says what the reader asked for and this opens it. Every
 * result surface sends the same request, and every one of them is answered here.
 *
 * Only an `http` or `https` address is followed. The view already refuses anything else before it
 * draws a link, and a value read out of a database is not a reason to hand the operating system a
 * `file:` or a `command:` URI.
 */
export async function followLinkFromView(message: unknown): Promise<boolean> {
  if (!isFollowLinkRequest(message)) return false;
  const address = followableAddress(message.href);
  if (address) await vscode.env.openExternal(vscode.Uri.parse(address));
  return true;
}
