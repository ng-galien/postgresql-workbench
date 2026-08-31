import * as vscode from "vscode";
import {
  type PostgresSourcePresentationInput,
  postgresSourcePresentation,
} from "../../../packages/presentation/src/presentation.js";

export const CODE_MONIKER_URI_SCHEME = "code+moniker";

export function codeMonikerUri(symbolUri: string): vscode.Uri {
  const uri = vscode.Uri.parse(symbolUri, true);
  if (uri.scheme !== CODE_MONIKER_URI_SCHEME) {
    throw new Error(`Expected a canonical Code Moniker URI, received: ${symbolUri}`);
  }
  return uri;
}

export function codeMonikerDocumentUri(
  symbolUri: string,
  source: PostgresSourcePresentationInput,
): vscode.Uri {
  const presentation = postgresSourcePresentation(source);
  codeMonikerUri(symbolUri);
  return vscode.Uri.from({
    scheme: CODE_MONIKER_URI_SCHEME,
    authority: "postgresql",
    path: `/${presentation.path}`,
    query: JSON.stringify({ identity: symbolUri, label: presentation.displayPath }),
  });
}

export function codeMonikerIdentityUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== CODE_MONIKER_URI_SCHEME) {
    throw new Error(`Expected a Code Moniker document URI, received: ${uri.toString(true)}`);
  }
  if (uri.query) {
    try {
      const projection = JSON.parse(uri.query) as { identity?: unknown };
      if (typeof projection.identity === "string") {
        return codeMonikerUri(projection.identity);
      }
    } catch {}
  }
  return uri.with({ query: "", fragment: "" });
}

export function codeMonikerUriString(uri: vscode.Uri): string {
  if (uri.scheme !== CODE_MONIKER_URI_SCHEME) {
    throw new Error(`Expected a canonical Code Moniker URI, received: ${uri.toString(true)}`);
  }
  return codeMonikerIdentityUri(uri).toString(true);
}
