// The Workbench Index lifecycle owns a dedicated one-worker lane. These scenarios gate index
// phases, add a second Connection on the same database, and reload the window — each of which
// rebuilds or suspends the index. Keeping them here lets every other scenario share one settled
// index instead of racing the rebuild they leave behind.
import "./workbench/indexing-feedback.spec.js";
import "./workbench/scratchpad-association.spec.js";
import "./workbench/scratchpad-shutdown.spec.js";
import "./workbench/source-tab-cleanup.spec.js";
