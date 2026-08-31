/**
 * The Cockpit inside VS Code: the panel that hosts the graph webview, the view that drives it,
 * and the synchronization with the Sources tree.
 * What the graph shows is computed in `packages/catalog`; this module only wires it to VS Code.
 * This file is the module's public surface.
 */
export { GraphNavigation, type GraphNavigationSnapshot } from "./navigation.js";
export { WorkbenchGraphPanel } from "./panel.js";
export { WorkbenchGraphTreeSync } from "./treeSync.js";
export { WorkbenchGraphView } from "./view.js";
