/**
 * Connections: the PostgreSQL connections the user saved, and which of them are open. Which
 * Connection each call site uses lives in packages/catalog (callSiteAssociations), imported from
 * there by every consumer.
 *
 * The module has two public doors, and nothing else under `connection/` may be imported:
 * - this file, for everything that runs inside VS Code (opening, commands);
 * - `savedConnections.ts`, for the saved records and their display name, which are pure and
 *   therefore usable from code and tests that must not load VS Code.
 *
 * `ConnectionStore` is still exposed here because commands, provisioning, and activation reach the
 * saved entries directly; closing that leak means routing them through `ConnectionManager`.
 */

export {
  type ConnectionChange,
  ConnectionManager,
  type DebugCapabilitySnapshot,
} from "./openConnections.js";
export { registerConnectionCommands } from "./registerCommands.js";
export { ConnectionStore } from "./savedConnections.js";
