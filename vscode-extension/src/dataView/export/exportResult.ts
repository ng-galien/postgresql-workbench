import { createWriteStream } from "node:fs";
import type { Client } from "pg";
import * as vscode from "vscode";
import {
  formatQueryResultRow,
  queryResultColumns,
} from "../../../../packages/dap/src/debugger/launch/boundedQueryResult.js";
import {
  type DataViewExportChoice,
  type DataViewExportFormat,
  type DataViewExportScope,
  type DataViewExportWriter,
  dataViewExportText,
  dataViewExportWriter,
  type ExportColumn,
  exportFileExtension,
} from "../../../../packages/rows/src/export.js";
import { TEXT_PASSTHROUGH_TYPES } from "../../../../packages/rows/src/openRows.js";
import { PostgresCursorReader } from "../../scratchpad/index.js";

const EXPORT_BATCH_ROWS = 5_000;

/** Asks where to export; undefined when the reader cancels. */
export async function pickExportTarget(
  title: string,
  format: DataViewExportFormat,
  scope: DataViewExportScope,
): Promise<vscode.Uri | undefined> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const extension = exportFileExtension(format);
  const baseName = `${title.replace(/[^\w.-]+/gu, "_")}.${extension}`;
  return vscode.window.showSaveDialog({
    defaultUri: workspaceUri ? vscode.Uri.joinPath(workspaceUri, baseName) : undefined,
    saveLabel: scope === "all" ? "Export every row" : "Export these rows",
    filters: { [format.toUpperCase()]: [extension] },
  });
}

/** Writes rows the view already holds — the reader's selection, or everything on screen. */
export async function exportHeldRows(
  target: vscode.Uri,
  choice: DataViewExportChoice,
  values: { columns: readonly ExportColumn[]; rows: readonly (readonly (string | null)[])[] },
): Promise<number> {
  const contents = dataViewExportText(values.columns, values.rows, choice);
  await vscode.workspace.fs.writeFile(target, Buffer.from(contents, "utf8"));
  return values.rows.length;
}

/** Streams the complete result of the query to a file, batch by batch, with progress and cancel. */
export async function exportAllRows(options: {
  target: vscode.Uri;
  choice: DataViewExportChoice;
  sql: string;
  title: string;
  openClient(): Promise<Client>;
  /** The type a column was declared with, where the document knows it; a CREATE TABLE reads it. */
  typeFor?: (name: string) => string | undefined;
}): Promise<number> {
  const { target, choice, sql, title } = options;
  let exported = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${title}`,
      cancellable: true,
    },
    async (progress, token) => {
      const client = await options.openClient();
      const reader = new PostgresCursorReader(client, sql, { types: TEXT_PASSTHROUGH_TYPES });
      let writer: DataViewExportWriter | undefined;
      try {
        const stream = createWriteStream(target.fsPath, { encoding: "utf8" });
        const write = (text: string) =>
          new Promise<void>((resolve, reject) => {
            stream.write(text, (error) => (error ? reject(error) : resolve()));
          });
        try {
          while (!token.isCancellationRequested) {
            const batch = await reader.read(EXPORT_BATCH_ROWS);
            if (!writer && batch.fields.length > 0) {
              // The columns are only known once the first batch has arrived with its fields.
              writer = dataViewExportWriter(
                queryResultColumns(batch.fields).map((column) => ({
                  name: column.name,
                  ...(options.typeFor?.(column.name) ? { type: options.typeFor(column.name) } : {}),
                })),
                choice,
              );
              await write(writer.opening());
            }
            const chunks: string[] = [];
            for (const raw of batch.rows) {
              const cells = formatQueryResultRow(raw, batch.fields);
              chunks.push(
                writer?.row(
                  cells.map((cell) => cell.value),
                  exported,
                ) ?? "",
              );
              exported += 1;
            }
            await write(chunks.join(""));
            progress.report({ message: `${exported.toLocaleString("en-US")} rows` });
            if (batch.rows.length < EXPORT_BATCH_ROWS) break;
          }
          await write(writer?.closing() ?? "");
        } finally {
          await new Promise<void>((resolve) => stream.end(resolve));
        }
      } finally {
        await reader.close().catch(() => {});
      }
      if (token.isCancellationRequested) throw new Error("Export cancelled.");
    },
  );
  return exported;
}
