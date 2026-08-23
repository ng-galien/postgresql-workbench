import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/**
 * What the views' own colour names are worth under VS Code.
 *
 * A view names the colours it paints with and knows nothing about themes; saying what those names
 * are worth here is adapting the engine to VS Code, which is this extension's whole job. The
 * editor takes semantic colours from theme rules a webview cannot read, so they are mapped onto
 * the symbol and chart colours it does hand us — the ones the outline and the suggest widget
 * already use — and a relation reads in a view close to how it reads in a tab. What matters as
 * much as the family is that they stay apart: an alias standing for a relation must not be the
 * colour of a column of it, or a reader cannot see which is which.
 */
const VIEW_COLOUR_NAMES = `:root {
  --postgres-name-schema: var(--vscode-descriptionForeground);
  --postgres-name-relation: var(--vscode-symbolIcon-classForeground);
  --postgres-name-alias: var(--vscode-charts-green);
  --postgres-name-column: var(--vscode-symbolIcon-fieldForeground);
  --postgres-name-routine: var(--vscode-symbolIcon-functionForeground);
  --postgres-name-parameter: var(--vscode-charts-yellow);
  --postgres-name-type: var(--vscode-symbolIcon-interfaceForeground);
  --postgres-field-unapplied: var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
  --postgres-scroll-thumb: var(--vscode-scrollbarSlider-background);
  --postgres-scroll-thumb-hover: var(--vscode-scrollbarSlider-hoverBackground);
  --postgres-scroll-thumb-active: var(--vscode-scrollbarSlider-activeBackground);
}`;

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
  <style>${VIEW_COLOUR_NAMES}</style>
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>${globalScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
