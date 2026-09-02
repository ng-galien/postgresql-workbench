/**
 * The host side of a held-rows export: choosing the file, streaming it, and telling the user.
 * Both hosts — the notebook result host and the debug results view — export through here; only
 * the entire-query scope differs, and the host that can re-run its statement injects it.
 */
import { createWriteStream } from "node:fs";
import * as vscode from "vscode";
import { dataViewExportChunks } from "../../../packages/rows/src/export.js";
import {
  type HeldResult,
  heldValuesForScope,
} from "../../../packages/views/src/results/heldResult.js";
import type { SqlResultExportRequest } from "../../../packages/views/src/results/payload.js";
import { pickExportTarget } from "../dataView/exportResult.js";

export async function answerExport(
  request: SqlResultExportRequest,
  held: HeldResult | undefined,
  options: {
    missingMessage: string;
    exportEntireQuery?: (target: vscode.Uri) => Promise<number>;
  },
): Promise<void> {
  try {
    if (!held) throw new Error(options.missingMessage);
    const target = await pickExportTarget(request.title, request.choice.format, request.scope);
    if (!target) return;
    const rowCount =
      request.scope === "all"
        ? await exportEntireQueryOrRefuse(options.exportEntireQuery, target)
        : await writeHeldExport(target, held, request);
    void vscode.window.showInformationMessage(
      `Exported ${rowCount.toLocaleString("en-US")} rows to ${target.fsPath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Result export failed: ${message}`);
  }
}

function exportEntireQueryOrRefuse(
  exportEntireQuery: ((target: vscode.Uri) => Promise<number>) | undefined,
  target: vscode.Uri,
): Promise<number> {
  if (!exportEntireQuery) throw new Error("The query text is no longer available.");
  return exportEntireQuery(target);
}

async function writeHeldExport(
  target: vscode.Uri,
  held: HeldResult,
  request: SqlResultExportRequest,
): Promise<number> {
  const values = heldValuesForScope(held, request);
  const stream = createWriteStream(target.fsPath, { encoding: "utf8" });
  try {
    for (const chunk of dataViewExportChunks(values.columns, values.rows, request.choice)) {
      await writeStreamChunk(stream, chunk);
    }
  } finally {
    await endStream(stream);
  }
  return values.rows.length;
}

function writeStreamChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function endStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}
