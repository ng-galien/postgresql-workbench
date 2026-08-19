/**
 * The CodeLens actions above SQL: which statements can be debugged or run, and the PL/pgSQL
 * diagnostics shown beside them. This file is the module's public surface for code that runs
 * inside VS Code; `policy.ts` is the pure door.
 */
export { PlpgsqlDiagnosticsProvider } from "./diagnostics.js";
export {
  debuggableSqlCall,
  debuggableSqlDefinition,
  type SqlDebugAvailability,
} from "./policy.js";
export {
  type CommandCallSite,
  type CommandFunctionDefinition,
  type CommandSqlStatement,
  type DocumentConnectionTarget,
  SqlCodeLensProvider,
} from "./provider.js";
