/**
 * The Workbench: the indexed catalog of a Connection's database, the Sources tree it feeds, the
 * graph view, and the DDL synchronization that keeps the index fresh. This file is the module's
 * public surface for everything that runs inside VS Code.
 *
 * `treeModel.ts`, `objectActions.ts`, `relations.ts` and `ddlSyncSettings.ts` are the module's
 * pure doors: they carry no VS Code import, so the graph webview and pure tests enter through
 * them. Nothing else under `workbench/` may be imported from outside.
 */

export { WorkbenchSourceUris } from "./sourceUris.js";
export {
  FunctionItem,
  PlpgsqlTreeItem,
  ServerItem,
  WorkbenchDdlSyncItem,
  WorkbenchObjectItem,
  WorkbenchRelationTargetItem,
  WorkbenchTreeProvider,
} from "./tree.js";
export { WorkbenchTreeDragAndDropController } from "./treeDragAndDrop.js";
