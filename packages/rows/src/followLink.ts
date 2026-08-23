/**
 * Following an address a result holds.
 *
 * A view cannot open a browser: in a VS Code webview the sandbox refuses a popup, and the host
 * only answers a click a person actually made — a click the grid dispatches itself is ignored, so
 * a menu entry that synthesised one did nothing at all. What a view can do is say what the reader
 * asked for, and let whoever put it on screen decide what that means: the extension opens it
 * externally, the browser harness opens a tab.
 *
 * The request is shared by every surface that draws a result — the Data View, a Scratchpad result,
 * the debugger's — because the intent is the same one and a reader met it in the same grid.
 */
export interface FollowLinkRequest {
  type: "follow-link";
  href: string;
}

/** What a view posts when a reader asks for the address a cell holds. */
export function followLinkRequest(href: string): FollowLinkRequest {
  return { type: "follow-link", href };
}

/** Whether a message a host received is that request. */
export function isFollowLinkRequest(message: unknown): message is FollowLinkRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "follow-link" &&
    typeof (message as { href?: unknown }).href === "string"
  );
}

/**
 * The address a host may hand to the operating system, or nothing.
 *
 * A view refuses anything but `http` and `https` before it draws a link, and this refuses it again
 * where it would be acted on: a value read out of a database is not a reason to open a `file:` or
 * a `command:` URI, and the two sides of that rule must not be able to drift apart.
 */
export function followableAddress(href: string): string | undefined {
  return /^https?:\/\/\S+$/u.test(href.trim()) ? href.trim() : undefined;
}
