// Keep the Core lane modular while declaring its single-worker state order explicitly.
// Exercise refresh first, group state-invalidating reloads and Connexion changes before the
// Notebook reconstruction barrier, then reuse that index for every consumer. Schema Sync runs in
// its own isolated lane because provisioning and cleanup intentionally mutate the indexed scope.
import "./workbench/cinematics.spec.js";
import "./workbench/indexing-feedback.spec.js";
import "./workbench/source-tab-cleanup.spec.js";
import "./workbench/scratchpad-association.spec.js";
import "./workbench/notebook.spec.js";
import "./workbench/graph-dnd.spec.js";
import "./workbench/search.spec.js";
import "./workbench/testing-coverage.spec.js";
import "./debugger/call-sites.spec.js";
import "./workbench/sql-authoring.spec.js";
