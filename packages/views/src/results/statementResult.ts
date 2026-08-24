import { countLabel } from "../../../rows/src/countLabel.js";
import type { ResultTable, SqlStatementResultPayload } from "../../../rows/src/resultPayload.js";
import { resultRowSummary } from "./resultFormatting.js";

export interface StatementResultCapabilities {
  selection: boolean;
  sorting: boolean;
  inspection: boolean;
  export: boolean;
  navigation: boolean;
  links: boolean;
}

/** Every result control gets its availability from this exhaustive policy. */
export function statementResultCapabilities(
  result: SqlStatementResultPayload,
): StatementResultCapabilities {
  switch (result.kind) {
    case "rowset":
      return {
        selection: true,
        sorting: true,
        inspection: true,
        export: true,
        navigation: true,
        links: true,
      };
    case "command-report":
      return {
        selection: true,
        sorting: true,
        inspection: false,
        export: false,
        navigation: false,
        links: false,
      };
  }
}

/** A command report is table-shaped for display and clipboard use, without pretending to be SQL rows. */
export function statementResultTable(result: SqlStatementResultPayload): ResultTable {
  if (result.kind === "rowset") return result;
  return {
    columns: [
      { name: "operation", dataTypeId: 25, typeName: "text" },
      { name: "rows_affected", dataTypeId: 20, typeName: "bigint" },
    ],
    rows: result.entries.map((entry) => [
      { kind: "text", value: entry.operation },
      { kind: "number", value: String(entry.affectedRows) },
    ]),
    rowCount: result.entries.length,
    capturedRowCount: result.entries.length,
    truncated: false,
    truncationReasons: [],
  };
}

export function statementResultBadge(result: SqlStatementResultPayload): string {
  if (result.kind === "rowset") return result.command;
  return result.entries.length === 1 ? (result.entries[0]?.operation ?? "COMMAND") : "COMMANDS";
}

export function statementResultRegionLabel(result: SqlStatementResultPayload): string {
  if (result.kind === "rowset") return "PostgreSQL query result";
  return result.entries.length === 1
    ? `PostgreSQL ${result.entries[0]?.operation ?? "command"} command report`
    : "PostgreSQL command report";
}

export function statementResultSummary(result: SqlStatementResultPayload): string {
  if (result.kind === "rowset") return resultRowSummary(result);
  const affected = result.entries.reduce((total, entry) => total + entry.affectedRows, 0);
  if (result.entries.length === 1) return `${countLabel(affected, "row")} affected`;
  return `${countLabel(affected, "row")} affected across ${countLabel(result.entries.length, "operation")}`;
}
