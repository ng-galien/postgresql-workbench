// Keep the feature scenarios modular while declaring their single-worker state order explicitly.
// Exercise refresh first, group state-invalidating reloads and Connexion changes before the
// Notebook reconstruction barrier, then reuse that index for every consumer. Schema Sync stays
// terminal because removing its provisioning intentionally marks the indexed scope stale.
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
import "./workbench/schema-sync.spec.js";
