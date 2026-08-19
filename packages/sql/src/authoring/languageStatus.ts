import type { SqlAuthoringDocumentContext, SqlAuthoringRejectionReason } from "./protocol.js";

export const INDEX_DATABASE_COMMAND = "postgresql-workbench.indexDatabase";
export const ASSIGN_DOCUMENT_CONNECTION_COMMAND = "postgresql-workbench.assignDocumentConnection";
export const CHANGE_SCRATCHPAD_CONNECTION_COMMAND =
  "postgresql-workbench.changeSqlNotebookConnection";
export const OPEN_SETTINGS_COMMAND = "workbench.action.openSettings";
export const SQL_AUTHORING_SYNTAX_SETTINGS_QUERY = "postgresql-workbench.sqlAuthoring.syntax";

/** Which Association governs one SQL document. */
export type SqlAuthoringScope = "scratchpad" | "document";

export interface SqlAuthoringCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface SqlAuthoringLanguageStatus {
  text: string;
  detail?: string;
  severity: "information" | "warning";
  command?: SqlAuthoringCommand;
}

export interface SqlAuthoringStatusInput {
  context: SqlAuthoringDocumentContext;
  documentUri: string;
  scope: SqlAuthoringScope;
  connexionName?: string;
}

export function changeAssociationCommand(
  documentUri: string,
  scope: SqlAuthoringScope,
): SqlAuthoringCommand | undefined {
  if (scope === "scratchpad") {
    return { title: "Change Association", command: CHANGE_SCRATCHPAD_CONNECTION_COMMAND };
  }
  if (scope === "document") {
    return {
      title: "Change Association",
      command: ASSIGN_DOCUMENT_CONNECTION_COMMAND,
      arguments: [{ documentUri }],
    };
  }
  return undefined;
}

export const REINDEX_COMMAND: SqlAuthoringCommand = {
  title: "Reindex",
  command: INDEX_DATABASE_COMMAND,
};

export const OPEN_SYNTAX_SETTINGS_COMMAND: SqlAuthoringCommand = {
  title: "Open Settings",
  command: OPEN_SETTINGS_COMMAND,
  arguments: [SQL_AUTHORING_SYNTAX_SETTINGS_QUERY],
};

/** Presentation of the SQL authoring context for the language status item. */
export function sqlAuthoringLanguageStatus(
  input: SqlAuthoringStatusInput,
): SqlAuthoringLanguageStatus {
  const { context, documentUri, scope } = input;
  const name = input.connexionName ?? "Connexion";
  const change = changeAssociationCommand(documentUri, scope);
  if (context.status === "available") {
    if (context.snapshot.status === "stale") {
      return {
        text: `Index stale for ${name}`,
        detail: "Completion and composition wait for a fresh Workbench Index.",
        severity: "warning",
        command: REINDEX_COMMAND,
      };
    }
    return {
      text: `SQL authoring: ${name}`,
      detail: scopeLabel(scope),
      severity: "information",
      command: change,
    };
  }
  if (context.status === "not-indexed") {
    return {
      text: `Index missing for ${name}`,
      detail: context.message,
      severity: "warning",
      command: REINDEX_COMMAND,
    };
  }
  if (context.status === "unassociated") {
    return {
      text: scope === "scratchpad" ? "No Scratchpad Association" : "No Document Association",
      detail: context.message,
      severity: "warning",
      command: change,
    };
  }
  return {
    text: "SQL authoring unavailable",
    detail: context.message,
    severity: "warning",
    command: change,
  };
}

/** Follow-up action offered with a composition rejection warning. */
export function sqlAuthoringRejectionAction(
  reason: SqlAuthoringRejectionReason | undefined,
  documentUri: string,
  scope: SqlAuthoringScope,
): SqlAuthoringCommand | undefined {
  switch (reason) {
    case "syntax-budget":
      return OPEN_SYNTAX_SETTINGS_COMMAND;
    case "stale":
    case "not-indexed":
      return REINDEX_COMMAND;
    case "unassociated":
    case "unavailable":
      return changeAssociationCommand(documentUri, scope);
    default:
      return undefined;
  }
}

function scopeLabel(scope: SqlAuthoringScope): string {
  switch (scope) {
    case "scratchpad":
      return "Scratchpad Association";
    case "document":
      return "Document Association";
  }
}
