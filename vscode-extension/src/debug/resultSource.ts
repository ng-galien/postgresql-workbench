import * as vscode from "vscode";
import type { DebugResultSource } from "../../../packages/dap/src/debugger/launch/index.js";

/** Names a captured result after the document and line the statement came from. */
export function debugResultSource(statement: {
  documentUri?: string;
  line?: number;
}): DebugResultSource | undefined {
  if (!statement.documentUri) return undefined;
  const uri = vscode.Uri.parse(statement.documentUri);
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    name: relative || uri.path.split("/").at(-1) || uri.toString(),
    uri: statement.documentUri,
    ...(statement.line ? { line: statement.line } : {}),
  };
}
