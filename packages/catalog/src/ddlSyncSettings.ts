import { validateSupportSchema } from "./postgresDdlSync.js";
import type { ConnectionConfig } from "./savedConnection.js";

export interface WorkbenchDdlSyncDefaults {
  enabled: boolean;
  supportSchema: string;
}

export interface WorkbenchDdlSyncConfiguration extends WorkbenchDdlSyncDefaults {
  enabledSource: "connection" | "settings";
  supportSchemaSource: "connection" | "settings";
}

export function resolveWorkbenchDdlSyncConfiguration(
  connection: ConnectionConfig,
  defaults: WorkbenchDdlSyncDefaults,
): WorkbenchDdlSyncConfiguration {
  const supportSchema = validateSupportSchema(
    connection.schemaSync?.supportSchema ?? defaults.supportSchema,
  );
  return {
    enabled: connection.schemaSync?.enabled ?? defaults.enabled,
    supportSchema,
    enabledSource: connection.schemaSync?.enabled === undefined ? "settings" : "connection",
    supportSchemaSource:
      connection.schemaSync?.supportSchema === undefined ? "settings" : "connection",
  };
}

export function classifyWorkbenchDdlSyncFailure(
  error: unknown,
): "insufficient-privilege" | "unavailable" {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  return code === "42501" ? "insufficient-privilege" : "unavailable";
}
