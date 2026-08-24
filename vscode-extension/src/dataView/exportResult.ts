import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "pg";
import * as vscode from "vscode";
import {
  formatQueryResultRowRetained,
  queryResultColumns,
} from "../../../packages/dap/src/debugger/launch/boundedQueryResult.js";
import { TEXT_PASSTHROUGH_TYPES } from "../../../packages/rows/src/dataView/openRows.js";
import {
  type DataViewExportChoice,
  type DataViewExportFormat,
  type DataViewExportScope,
  type DataViewExportWriter,
  dataViewExportChunks,
  dataViewExportWriter,
  type ExportColumn,
  exportFileExtension,
} from "../../../packages/rows/src/export.js";
import { PostgresOffsetQuerySource } from "../../../packages/rows/src/offsetQuery.js";

const EXPORT_BATCH_ROWS = 5_000;
const EXPORT_WRITE_CHUNK_BYTES = 256 * 1024;

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
  await writeAtomically(target, async (stream) => {
    for (const chunk of dataViewExportChunks(values.columns, values.rows, choice)) {
      await write(stream, chunk);
    }
  });
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
  /** Same hard per-cell boundary as the retained result values. */
  maxCellBytes?: number;
  /** PostgreSQL execution limit inherited from the result-producing surface. */
  statementTimeoutMs?: number;
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
      const source = new PostgresOffsetQuerySource(options.openClient, sql, {
        types: TEXT_PASSTHROUGH_TYPES,
        ...(options.statementTimeoutMs !== undefined
          ? {
              configure: async (client) => {
                await client.query("SELECT set_config('statement_timeout', $1, false)", [
                  String(options.statementTimeoutMs),
                ]);
              },
            }
          : {}),
      });
      const cancellation = token.onCancellationRequested?.(() => {
        void source.cancel().catch(() => {});
      }) ?? { dispose: () => {} };
      let writer: DataViewExportWriter | undefined;
      try {
        await writeAtomically(target, async (stream) => {
          while (!token.isCancellationRequested) {
            const batch = await source.read(exported, EXPORT_BATCH_ROWS);
            if (!writer && batch.fields.length > 0) {
              // The columns are only known once the first batch has arrived with its fields.
              writer = dataViewExportWriter(
                queryResultColumns(batch.fields).map((column) => ({
                  name: column.name,
                  ...(options.typeFor?.(column.name) ? { type: options.typeFor(column.name) } : {}),
                })),
                choice,
              );
              await write(stream, writer.opening());
            }
            let chunk = "";
            for (const raw of batch.rows) {
              const cells = formatQueryResultRowRetained(
                raw,
                batch.fields,
                options.maxCellBytes ?? 256 * 1024,
              );
              chunk +=
                writer?.row(
                  cells.map((cell) => cell.value),
                  exported,
                ) ?? "";
              exported += 1;
              if (Buffer.byteLength(chunk, "utf8") >= EXPORT_WRITE_CHUNK_BYTES) {
                await write(stream, chunk);
                chunk = "";
              }
            }
            if (chunk) await write(stream, chunk);
            progress.report({ message: `${exported.toLocaleString("en-US")} rows` });
            if (batch.rows.length < EXPORT_BATCH_ROWS) break;
          }
          await write(stream, writer?.closing() ?? "");
        });
      } finally {
        cancellation.dispose();
        await source.cancel().catch(() => {});
      }
      if (token.isCancellationRequested) throw new Error("Export cancelled.");
    },
  );
  return exported;
}

async function writeAtomically(
  target: vscode.Uri,
  writeFile: (stream: ReturnType<typeof createWriteStream>) => Promise<void>,
): Promise<void> {
  if (target.scheme && target.scheme !== "file") {
    throw new Error("Export currently supports local files only.");
  }
  const temporary = join(dirname(target.fsPath), `.${randomUUID()}.pgwb-export`);
  const stream = createWriteStream(temporary, { encoding: "utf8" });
  try {
    await writeFile(stream);
    await end(stream);
    await rename(temporary, target.fsPath);
  } catch (error) {
    stream.destroy();
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function write(stream: ReturnType<typeof createWriteStream>, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function end(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}
