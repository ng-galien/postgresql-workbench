/**
 * The Workbench: the indexed catalog of a Connection's database, the Sources tree it feeds, the
 * graph view, and the DDL synchronization that keeps the index fresh. This file is the module's
 * public surface for everything that runs inside VS Code.
 *
 * `treeModel.ts`, `objectActions.ts`, `relations.ts` and `ddlSyncSettings.ts` are the module's
 * pure doors: they carry no VS Code import, so the graph webview and pure tests enter through
 * them. Nothing else under `workbench/` may be imported from outside.
 */

export {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  type WorkbenchDatabaseIdentity,
  type WorkbenchObjectKind,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "../../../packages/catalog/src/objectModel.js";
export { WorkbenchDdlSyncController } from "./ddlSync.js";
export {
  WorkbenchIndexController,
  type WorkbenchIndexPhase,
  type WorkbenchIndexResult,
  type WorkbenchSourceDescriptor,
} from "./indexController.js";
export {
  actionsForWorkbenchSurface,
  buildWorkbenchObjectActions,
  type WorkbenchObjectAction,
  type WorkbenchObjectActionId,
  type WorkbenchObjectActionSurface,
} from "./objectActions.js";
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
