import type { SqlEditorRuntimeProps } from "./runtime.js";

const RUNTIME_GLOBAL = "__POSTGRESQL_WORKBENCH_SQL_EDITOR__";

/** Reads the transport and worker URLs materialized by the current browser host. */
export function sqlEditorPageRuntime(): Pick<
  SqlEditorRuntimeProps,
  "languageServerUrl" | "editorWorkerUrl"
> {
  const value = (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL];
  if (!value || typeof value !== "object") {
    throw new Error(`The host did not configure ${RUNTIME_GLOBAL}.`);
  }
  const configured = value as Record<string, unknown>;
  if (
    typeof configured.languageServerUrl !== "string" ||
    typeof configured.editorWorkerUrl !== "string"
  ) {
    throw new Error(`The host supplied an invalid ${RUNTIME_GLOBAL} configuration.`);
  }
  return {
    languageServerUrl: configured.languageServerUrl,
    editorWorkerUrl: configured.editorWorkerUrl,
  };
}
