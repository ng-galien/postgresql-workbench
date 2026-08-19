/**
 * The Cockpit inside VS Code: the panel that hosts the graph webview, the view that drives it,
 * the synchronization with the Sources tree, and the bridge that turns a tree drop into a focus.
 * What the graph shows is computed in `packages/catalog`; this module only wires it to VS Code.
 * This file is the module's public surface.
 */
export { registerWorkbenchGraphDropBridge, workbenchGraphDropUri } from "./dropBridge.js";
export { GraphNavigation, type GraphNavigationSnapshot } from "./navigation.js";
export { WorkbenchGraphPanel } from "./panel.js";
export { WorkbenchGraphTreeSync } from "./treeSync.js";
export { WorkbenchGraphView } from "./view.js";
