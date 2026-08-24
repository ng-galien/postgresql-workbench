/**
 * Connections: the PostgreSQL connections the user saved, which of them are open, and which Connection
 * each document uses.
 *
 * The module has two public doors, and nothing else under `connection/` may be imported:
 * - this file, for everything that runs inside VS Code (opening, commands, Associations);
 * - `savedConnections.ts`, for the saved records and their display name, which are pure and
 *   therefore usable from code and tests that must not load VS Code.
 *
 * `ConnectionStore` is still exposed here because commands, provisioning, and activation reach the
 * saved entries directly; closing that leak means routing them through `ConnectionManager`.
 */
export {
  type CallSiteConnectionReference,
  type CallSiteConnectionState,
  CallSiteConnectionStore,
} from "./associations.js";
export {
  type ConnectionChange,
  ConnectionManager,
  type DebugCapabilitySnapshot,
} from "./openConnections.js";
export { ConnectionStore } from "./savedConnections.js";
