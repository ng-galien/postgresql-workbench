import type { WorkbenchObjectKind } from "../../../catalog/src/objectModel.js";

export const WORKBENCH_GRAPH_OBJECT_MIME = "application/vnd.postgresql-workbench.graph-object";
export const WORKBENCH_GRAPH_UNSUPPORTED_MIME =
  "application/vnd.postgresql-workbench.graph-unsupported";
export const WORKBENCH_TREE_MIME = "application/vnd.code.tree.postgresql-workbench-connections";

/** True when a native VS Code drag from the Workbench tree is over a webview. */
export function hasWorkbenchTreeDrag(dataTransfer: DataTransfer): boolean {
  return [...dataTransfer.types].some((type) => type.toLocaleLowerCase() === WORKBENCH_TREE_MIME);
}

export interface WorkbenchGraphObjectDragPayload {
  version: 1;
  availability: "accepted";
  connectionId: string;
  database: string;
  sourceUri: string;
  symbolUri: string;
  kind: WorkbenchObjectKind;
  label: string;
}

export interface WorkbenchGraphUnsupportedDragPayload {
  version: 1;
  availability: "unsupported";
  label: string;
  reason: string;
}

export type WorkbenchGraphDragPayload =
  | WorkbenchGraphObjectDragPayload
  | WorkbenchGraphUnsupportedDragPayload;

export function serializeWorkbenchGraphDrag(payload: WorkbenchGraphDragPayload): string {
  return JSON.stringify(payload);
}

export function parseWorkbenchGraphDrag(value: string): WorkbenchGraphDragPayload | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<WorkbenchGraphDragPayload>;
    if (parsed.version !== 1 || typeof parsed.label !== "string") return undefined;
    if (parsed.availability === "unsupported") {
      return typeof parsed.reason === "string"
        ? (parsed as WorkbenchGraphUnsupportedDragPayload)
        : undefined;
    }
    if (
      parsed.availability !== "accepted" ||
      typeof parsed.connectionId !== "string" ||
      typeof parsed.database !== "string" ||
      typeof parsed.sourceUri !== "string" ||
      typeof parsed.symbolUri !== "string" ||
      !isWorkbenchObjectKind(parsed.kind)
    ) {
      return undefined;
    }
    return parsed as WorkbenchGraphObjectDragPayload;
  } catch {
    return undefined;
  }
}

function isWorkbenchObjectKind(value: unknown): value is WorkbenchObjectKind {
  return (
    value === "table" ||
    value === "view" ||
    value === "function" ||
    value === "procedure" ||
    value === "trigger"
  );
}
