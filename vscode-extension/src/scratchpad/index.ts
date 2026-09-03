/**
 * Scratchpads: the SQL notebooks the user runs statements in — their file format, their Connection
 * Association, LIMIT/OFFSET result pages, and the explicit transactions they hold.
 * This file is the module's one public door for code that runs inside VS Code; the file format
 * itself lives in packages/scratchpad, imported from there by every consumer.
 */

export {
  NEW_SQL_NOTEBOOK_COMMAND,
  registerSqlNotebook,
  type ScratchpadDebugEligibility,
  type ScratchpadDebugger,
  type ScratchpadDebugOutcome,
  type ScratchpadFeature,
} from "./registerCommands.js";
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
