// Keep the user journeys modular while declaring their shared-instance order explicitly.
// The reload journey invalidates the in-memory index; schema synchronization is therefore
// the only scenario allowed to rebuild it, and remains last.
import "./workbench/graph-dnd.spec.js";
import "./workbench/search.spec.js";
import "./workbench/notebook.spec.js";
import "./workbench/testing-coverage.spec.js";
import "./debugger/call-sites.spec.js";
import "./workbench/source-tab-cleanup.spec.js";
import "./workbench/schema-sync.spec.js";
