import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  parseWorkbenchGraphDrag,
  serializeWorkbenchGraphDrag,
  type WorkbenchGraphDragPayload,
} from "./workbenchGraph/dragAndDrop.js";

export const WORKBENCH_GRAPH_DROP_SCHEME = "postgresql-workbench-graph-drop";

export interface WorkbenchGraphDropTarget {
  acceptTreeDrop(payload: WorkbenchGraphDragPayload): Promise<boolean>;
  reveal(): void;
}

export function workbenchGraphDropUri(payload: WorkbenchGraphDragPayload): string {
  const encoded = Buffer.from(serializeWorkbenchGraphDrag(payload), "utf8").toString("base64url");
  return `${WORKBENCH_GRAPH_DROP_SCHEME}:/source/${randomUUID()}/${encoded}`;
}

export function parseWorkbenchGraphDropUri(uri: vscode.Uri): WorkbenchGraphDragPayload | undefined {
  if (uri.scheme !== WORKBENCH_GRAPH_DROP_SCHEME) return undefined;
  const encoded = uri.path.split("/").filter(Boolean).at(-1);
  if (!encoded) return undefined;
  try {
    return parseWorkbenchGraphDrag(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function registerWorkbenchGraphDropBridge(
  context: vscode.ExtensionContext,
  target: WorkbenchGraphDropTarget,
): void {
  const provider = vscode.workspace.registerTextDocumentContentProvider(
    WORKBENCH_GRAPH_DROP_SCHEME,
    {
      provideTextDocumentContent(uri) {
        const payload = parseWorkbenchGraphDropUri(uri);
        return payload
          ? `Adding ${payload.label} to the PostgreSQL Cockpit…\n`
          : "Invalid PostgreSQL Workbench graph drop.\n";
      },
    },
  );
  const opened = vscode.workspace.onDidOpenTextDocument((document) => {
    const payload = parseWorkbenchGraphDropUri(document.uri);
    if (!payload) return;
    void completeGraphDrop(document.uri, payload, target);
  });
  context.subscriptions.push(provider, opened);
}

export async function completeGraphDrop(
  documentUri: vscode.Uri,
  payload: WorkbenchGraphDragPayload,
  target: WorkbenchGraphDropTarget,
): Promise<void> {
  await closeSyntheticTab(documentUri);
  let accepted = false;
  try {
    accepted = await target.acceptTreeDrop(payload);
  } finally {
    await closeSyntheticTab(documentUri);
  }
  if (accepted) target.reveal();
}

async function closeSyntheticTab(documentUri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (candidate) =>
        candidate.input instanceof vscode.TabInputText &&
        candidate.input.uri.toString() === documentUri.toString(),
    );
  if (tab) await vscode.window.tabGroups.close(tab);
}
