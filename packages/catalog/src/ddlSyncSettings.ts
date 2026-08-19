import { validateSupportSchema } from "../../../packages/catalog/src/postgresDdlSync.js";
import type { ServerConfig } from "./savedConnection.js";

export interface WorkbenchDdlSyncDefaults {
  enabled: boolean;
  supportSchema: string;
}

export interface WorkbenchDdlSyncConfiguration extends WorkbenchDdlSyncDefaults {
  enabledSource: "connection" | "settings";
  supportSchemaSource: "connection" | "settings";
}

export function resolveWorkbenchDdlSyncConfiguration(
  server: ServerConfig,
  defaults: WorkbenchDdlSyncDefaults,
): WorkbenchDdlSyncConfiguration {
  const supportSchema = validateSupportSchema(
    server.schemaSync?.supportSchema ?? defaults.supportSchema,
  );
  return {
    enabled: server.schemaSync?.enabled ?? defaults.enabled,
    supportSchema,
    enabledSource: server.schemaSync?.enabled === undefined ? "settings" : "connection",
    supportSchemaSource: server.schemaSync?.supportSchema === undefined ? "settings" : "connection",
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
