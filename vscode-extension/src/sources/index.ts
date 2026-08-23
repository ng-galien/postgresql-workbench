/**
 * Sources: the read-only tabs that show what PostgreSQL actually holds — routine bodies opened
 * from the Workbench, their canonical `code+moniker://` identity, and the DAP source tabs a debug
 * session leaves behind. This file is the module's public surface for code that runs inside
 * VS Code.
 */

export { CodeMonikerContentProvider } from "./contentProvider.js";
export { closePostgresqlDapTabs } from "./dapSource.js";
export {
  CODE_MONIKER_URI_SCHEME,
  codeMonikerDocumentUri,
  codeMonikerIdentityUri,
  codeMonikerUri,
} from "./uri.js";
