import { createWriteStream } from "node:fs";
import type { Client } from "pg";
import * as vscode from "vscode";
import {
  formatQueryResultRow,
  queryResultColumns,
} from "../../../../packages/dap/src/debugger/launch/boundedQueryResult.js";
import type { DebugResultColumn } from "../../../../packages/dap/src/debugger/launch/index.js";
import { TEXT_PASSTHROUGH_TYPES } from "../../../../packages/rows/src/openRows.js";
import { delimitedHeader, delimitedRow, resultAsDelimited } from "../../debug/index.js";
import type { SqlNotebookResultPayload } from "../../scratchpad/index.js";
import { PostgresCursorReader } from "../../scratchpad/index.js";

export type DataViewExportFormat = "csv" | "tsv" | "json";

const EXPORT_BATCH_ROWS = 5_000;

/** Asks where to export; undefined when the user cancels. */
export async function pickExportTarget(
  title: string,
  format: DataViewExportFormat,
  scope: "loaded" | "all",
): Promise<vscode.Uri | undefined> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const baseName = `${title.replace(/[^\w.-]+/gu, "_")}.${format}`;
  return vscode.window.showSaveDialog({
    defaultUri: workspaceUri ? vscode.Uri.joinPath(workspaceUri, baseName) : undefined,
    saveLabel: scope === "all" ? "Export all rows" : "Export loaded rows",
    filters: { [format.toUpperCase()]: [format] },
  });
}

/** Writes the rows currently loaded in the grid. */
export async function exportLoadedRows(
  target: vscode.Uri,
  format: DataViewExportFormat,
  payload: SqlNotebookResultPayload,
  query: string,
): Promise<void> {
  const contents =
    format === "json"
      ? JSON.stringify(
          {
            query,
            columns: payload.columns,
            rows: payload.rows.map((row) => row.map((cell) => cell.value)),
          },
          null,
          2,
        )
      : resultAsDelimited(payload, format === "tsv" ? "\t" : ",");
  await vscode.workspace.fs.writeFile(target, Buffer.from(contents, "utf8"));
}

/** Streams the complete result of the query to a file, batch by batch, with progress and cancel. */
export async function exportAllRows(options: {
  target: vscode.Uri;
  format: DataViewExportFormat;
  sql: string;
  title: string;
  openClient(): Promise<Client>;
}): Promise<void> {
  const { target, format, sql, title } = options;
  const delimiter = format === "tsv" ? "\t" : ",";
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${title}`,
      cancellable: true,
    },
    async (progress, token) => {
      const client = await options.openClient();
      const reader = new PostgresCursorReader(client, sql, { types: TEXT_PASSTHROUGH_TYPES });
      let exported = 0;
      let columns: DebugResultColumn[] | undefined;
      try {
        const stream = createWriteStream(target.fsPath, { encoding: "utf8" });
        const write = (text: string) =>
          new Promise<void>((resolve, reject) => {
            stream.write(text, (error) => (error ? reject(error) : resolve()));
          });
        try {
          if (format === "json") await write("[\n");
          while (!token.isCancellationRequested) {
            const batch = await reader.read(EXPORT_BATCH_ROWS);
            if (!columns && batch.fields.length > 0) {
              columns = queryResultColumns(batch.fields);
              if (format !== "json") await write(`${delimitedHeader(columns, delimiter)}\n`);
            }
            const chunks: string[] = [];
            for (const raw of batch.rows) {
              const cells = formatQueryResultRow(raw, batch.fields);
              if (format === "json") {
                const record = Object.fromEntries(
                  cells.map((cell, index) => [columns?.[index]?.name ?? String(index), cell.value]),
                );
                chunks.push(`${exported > 0 ? ",\n" : ""}${JSON.stringify(record)}`);
              } else {
                chunks.push(`${delimitedRow(cells, delimiter)}\n`);
              }
              exported += 1;
            }
            await write(chunks.join(""));
            progress.report({ message: `${exported.toLocaleString("en-US")} rows` });
            if (batch.rows.length < EXPORT_BATCH_ROWS) break;
          }
          if (format === "json") await write("\n]\n");
        } finally {
          await new Promise<void>((resolve) => stream.end(resolve));
        }
      } finally {
        await reader.close().catch(() => {});
      }
      if (token.isCancellationRequested) throw new Error("Export cancelled.");
    },
  );
}
