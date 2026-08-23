/**
 * The Workbench: the indexed catalog of a Connection's database, the Sources tree it feeds, the
 * graph view, and the DDL synchronization that keeps the index fresh. This file is the module's
 * public surface for everything that runs inside VS Code.
 *
 * What it indexes, what a Workbench object is and what may be done to one are the catalogue's:
 * import those from `packages/catalog`. What is left here is the tree, its drag and drop, the
 * object picker and the source URIs — everything that only means something inside VS Code.
 * Nothing else under `workbench/` may be imported from outside.
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
