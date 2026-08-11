import * as vscode from "vscode";
import {
  serializeWorkbenchGraphDrag,
  WORKBENCH_GRAPH_OBJECT_MIME,
  WORKBENCH_GRAPH_UNSUPPORTED_MIME,
  type WorkbenchGraphDragPayload,
} from "./workbenchGraph/dragAndDrop.js";
import { workbenchGraphDropUri } from "./workbenchGraphDropBridge.js";
import type { WorkbenchObjectModel } from "./workbenchTreeModel.js";
import type { PlpgsqlTreeItem } from "./workbenchTreeProvider.js";

export class WorkbenchTreeDragAndDropController
  implements vscode.TreeDragAndDropController<PlpgsqlTreeItem>, vscode.Disposable
{
  private active?: { payload: WorkbenchGraphDragPayload; expiresAt: number };
  private expiry?: ReturnType<typeof setTimeout>;
  readonly dropMimeTypes: readonly string[] = [];
  readonly dragMimeTypes = [
    WORKBENCH_GRAPH_OBJECT_MIME,
    WORKBENCH_GRAPH_UNSUPPORTED_MIME,
    "text/plain",
    "text/uri-list",
  ];

  constructor(
    private readonly announce: (payload: WorkbenchGraphDragPayload | null) => void = () => {},
  ) {}

  handleDrag(source: readonly PlpgsqlTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const payload = dragPayload(source);
    if (this.expiry) clearTimeout(this.expiry);
    this.active = payload ? { payload, expiresAt: Date.now() + 30_000 } : undefined;
    this.announce(payload ?? null);
    if (!payload) return;
    this.expiry = setTimeout(() => {
      this.active = undefined;
      this.announce(null);
    }, 30_000);
    const serialized = serializeWorkbenchGraphDrag(payload);
    dataTransfer.set(
      payload.availability === "accepted"
        ? WORKBENCH_GRAPH_OBJECT_MIME
        : WORKBENCH_GRAPH_UNSUPPORTED_MIME,
      new vscode.DataTransferItem(serialized),
    );
    dataTransfer.set("text/plain", new vscode.DataTransferItem(serialized));
    dataTransfer.set("text/uri-list", new vscode.DataTransferItem(workbenchGraphDropUri(payload)));
  }

  activePayload(consume = false): WorkbenchGraphDragPayload | undefined {
    const current = this.active;
    if (!current || current.expiresAt < Date.now()) {
      this.active = undefined;
      return undefined;
    }
    if (consume) {
      this.active = undefined;
      if (this.expiry) clearTimeout(this.expiry);
      this.expiry = undefined;
      this.announce(null);
    }
    return current.payload;
  }

  dispose(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.active = undefined;
    this.announce(null);
  }
}

export function dragPayload(
  source: readonly PlpgsqlTreeItem[],
): WorkbenchGraphDragPayload | undefined {
  if (source.length !== 1) {
    return source.some(isSourcesItem)
      ? unsupported("Selected items", "Drop one PostgreSQL object at a time.")
      : undefined;
  }
  const item = source[0];
  const object = graphObject(item);
  if (object) {
    return {
      version: 1,
      availability: "accepted",
      serverId: object.serverId,
      database: object.database,
      sourceUri: object.sourceUri,
      symbolUri: object.symbolUri,
      kind: object.kind,
      label: `${object.schema}.${object.name}`,
    };
  }
  switch (item.kind) {
    case "schema":
      return unsupported(
        item.schema,
        "Schemas are not graph nodes. Drop a table, view, routine, or trigger.",
      );
    case "extensionGroup":
      return unsupported(treeLabel(item), "Object groups cannot be added to the graph.");
    case "tableMember":
      return unsupported(
        item.member.name,
        "Columns and constraints are shown through their parent table.",
      );
    case "relationGroup":
      return unsupported(treeLabel(item), "Relation groups are not graph nodes.");
    case "relationTarget":
      return unsupported(
        treeLabel(item),
        "This relation target is not a projectable PostgreSQL object.",
      );
    default:
      return undefined;
  }
}

function graphObject(item: PlpgsqlTreeItem): WorkbenchObjectModel | undefined {
  if (item.kind === "function" || item.kind === "object") return item.object;
  if (item.kind === "relationTarget") return item.target.object;
  return undefined;
}

function isSourcesItem(item: PlpgsqlTreeItem): boolean {
  return (
    item.kind === "schema" ||
    item.kind === "extensionGroup" ||
    item.kind === "function" ||
    item.kind === "object" ||
    item.kind === "tableMember" ||
    item.kind === "relationGroup" ||
    item.kind === "relationTarget"
  );
}

function unsupported(label: string, reason: string): WorkbenchGraphDragPayload {
  return { version: 1, availability: "unsupported", label, reason };
}

function treeLabel(item: vscode.TreeItem): string {
  if (typeof item.label === "string") return item.label;
  return item.label?.label ?? "Sources item";
}
