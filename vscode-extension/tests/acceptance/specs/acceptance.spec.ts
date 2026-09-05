// Every scenario in the Core lane consumes one index, indexed once for the worker and never
// invalidated: the two families that disturb it — the index lifecycle itself and Schema Sync —
// each own an isolated lane.
import "./workbench/cinematics.spec.js";
import "./workbench/notebook.spec.js";
import "./workbench/scratchpad-commands.spec.js";
import "./workbench/graph-dnd.spec.js";
import "./workbench/search.spec.js";
import "./workbench/testing-coverage.spec.js";
import "./debugger/call-sites.spec.js";
import "./workbench/sql-authoring.spec.js";
import "./workbench/data-view.spec.js";
import "./workbench/connections-page.spec.js";
import "./workbench/mcp-settings.spec.js";
