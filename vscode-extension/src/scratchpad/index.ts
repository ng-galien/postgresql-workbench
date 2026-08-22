/**
 * Scratchpads: the SQL notebooks the user runs statements in — their file format, their Connection
 * Association, the bounded cursor that streams results, and the explicit transactions they hold.
 * The module has two public doors, and nothing else under `scratchpad/` may be imported:
 * - this file, for everything that runs inside VS Code;
 * - `notebookFile.ts`, for the file format and result payload types, which are pure and therefore
 *   usable from the renderer webview and from tests that must not load VS Code.
 */

export {
  type NotebookBindingSnapshot,
  nextSqlNotebookName,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveScratchpadAssociation,
  type ScratchpadAssociation,
  SQL_NOTEBOOK_EXTENSION,
  SQL_NOTEBOOK_RESULT_MIME,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookMetadata,
  scratchpadExecutionMode,
} from "./notebookFile.js";
export {
  NEW_SQL_NOTEBOOK_COMMAND,
  registerSqlNotebook,
  type ScratchpadDebugEligibility,
  type ScratchpadDebugger,
  type ScratchpadDebugOutcome,
  type ScratchpadFeature,
} from "./register.js";
export { sqlResultSettings } from "./scratchpadSettings.js";
export {
  type ScratchpadTransaction,
  ScratchpadTransactionManager,
} from "./transactions.js";
export {
  OPEN_SQL_NOTEBOOK_COMMAND,
  type SqlNotebookEntry,
  SqlNotebookWorkspace,
  sqlNotebookDisplayName,
} from "./workspace.js";
