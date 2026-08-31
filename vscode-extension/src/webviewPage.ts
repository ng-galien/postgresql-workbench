import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { vscodeThemeOverrides } from "./presentation/vscodeTheme.js";

/**
 * The HTML shell every Workbench webview loads: a fresh nonce, a Content Security Policy that
 * admits only that nonce, and the `#root` its bundle mounts into. One place, so a policy is
 * written — and fixed — once for the Data View, the debugger output and the Cockpit graph.
 */
export function webviewPage(options: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  /** Bundle under `dist/` that mounts into `#root`. */
  script: string;
  /** Stylesheet under `dist/`, for a bundle that does not carry its styles inline. */
  stylesheet?: string;
  /** Policy directives this page needs beyond scripts, styles and fonts. */
  extraCsp?: readonly string[];
  /** Globals the bundle reads at load time, set by an inline script under the same nonce. */
  globals?: Readonly<Record<string, unknown>>;
}): string {
  const { webview, extensionUri, title, script, stylesheet, extraCsp = [], globals } = options;
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", script));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    ...extraCsp,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const styleLink = stylesheet
    ? `\n  <link href="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", stylesheet))}" rel="stylesheet">`
    : "";
  const globalScript = globals
    ? `\n  <script nonce="${nonce}">${Object.entries(globals)
        .map(([name, value]) => `globalThis.${name} = ${JSON.stringify(value)};`)
        .join("")}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">${styleLink}
  <style>${vscodeThemeOverrides()}</style>
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>${globalScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
