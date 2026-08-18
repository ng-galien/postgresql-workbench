import * as vscode from "vscode";
import {
  SQL_AUTHORING_OBJECT_MIME,
  type SqlAuthoringDragPayload,
  serializeSqlAuthoringDrag,
} from "./sqlAuthoring/protocol.js";
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
  private activeAuthoring?: { payload: SqlAuthoringDragPayload; expiresAt: number };
  private expiry?: ReturnType<typeof setTimeout>;
  readonly dropMimeTypes: readonly string[] = [];
  readonly dragMimeTypes = [
    WORKBENCH_GRAPH_OBJECT_MIME,
    WORKBENCH_GRAPH_UNSUPPORTED_MIME,
    SQL_AUTHORING_OBJECT_MIME,
    "text/plain",
    "text/uri-list",
  ];

  constructor(
    private readonly announce: (payload: WorkbenchGraphDragPayload | null) => void = () => {},
  ) {}

  handleDrag(source: readonly PlpgsqlTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const payload = dragPayload(source);
    const authoringPayload = sqlAuthoringDragPayload(source);
    if (this.expiry) clearTimeout(this.expiry);
    this.active = payload ? { payload, expiresAt: Date.now() + 30_000 } : undefined;
    this.activeAuthoring = authoringPayload
      ? { payload: authoringPayload, expiresAt: Date.now() + 30_000 }
      : undefined;
    this.announce(payload ?? null);
    if (authoringPayload) {
      dataTransfer.set(
        SQL_AUTHORING_OBJECT_MIME,
        new vscode.DataTransferItem(serializeSqlAuthoringDrag(authoringPayload)),
      );
    }
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

  /** SQL authoring payload of the ongoing tree drag, for webviews that compose SQL on drop. */
  activeAuthoringPayload(consume = false): SqlAuthoringDragPayload | undefined {
    const current = this.activeAuthoring;
    if (!current || current.expiresAt < Date.now()) {
      this.activeAuthoring = undefined;
      return undefined;
    }
    if (consume) this.activeAuthoring = undefined;
    return current.payload;
  }

  dispose(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.active = undefined;
    this.announce(null);
  }
}

export function sqlAuthoringDragPayload(
  source: readonly PlpgsqlTreeItem[],
): SqlAuthoringDragPayload | undefined {
  if (source.length !== 1) return undefined;
  const item = source[0];
  if (item.kind === "tableMember" && item.member.kind === "column") {
    return {
      kind: "column",
      serverId: item.object.serverId,
      database: item.object.database,
      tableOid: item.object.oid,
      tableSchema: item.object.schema,
      tableName: item.object.name,
      name: item.member.name,
    };
  }
  const object = graphObject(item);
  if (
    !object ||
    (object.kind !== "table" &&
      object.kind !== "view" &&
      object.kind !== "function" &&
      object.kind !== "procedure" &&
      object.kind !== "trigger")
  ) {
    return undefined;
  }
  return {
    kind: object.kind,
    serverId: object.serverId,
    database: object.database,
    oid: object.oid,
    schema: object.schema,
    name: object.name,
  };
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
