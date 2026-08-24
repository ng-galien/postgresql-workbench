import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { DataViewExportChoice } from "../../../packages/rows/src/export.js";

const batches = vi.hoisted(() => ({
  held: [] as Array<{ rows: unknown[][]; fields: unknown[]; command?: string }>,
  closed: vi.fn(),
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, { isCancellationRequested: false }),
  },
}));

vi.mock("../../../packages/rows/src/offsetQuery.js", () => ({
  PostgresOffsetQuerySource: class {
    async read() {
      return batches.held.shift() ?? { rows: [], fields: [] };
    }
    async cancel() {
      batches.closed();
    }
  },
}));

import { exportAllRows, exportHeldRows } from "./exportResult.js";

const choice = (format: DataViewExportChoice["format"]): DataViewExportChoice => ({
  format,
  header: true,
  nullAs: "empty",
  delimiter: ",",
  createTable: false,
  spreadsheetSafe: true,
  finalNewline: true,
});

let directory: string | undefined;
afterEach(async () => {
  batches.held = [];
  batches.closed.mockClear();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("result file export", () => {
  it("writes held rows incrementally to the chosen file", async () => {
    directory = await mkdtemp(join(tmpdir(), "pgwb-held-export-"));
    const file = join(directory, "rows.json");
    const rows = Array.from({ length: 2_000 }, (_, index) => [String(index), `row-${index}`]);

    await expect(
      exportHeldRows({ fsPath: file } as vscode.Uri, choice("json"), {
        columns: [{ name: "id" }, { name: "label" }],
        rows,
      }),
    ).resolves.toBe(2_000);

    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2_000);
  });

  it("replays and writes a complete query result batch by batch without display truncation", async () => {
    directory = await mkdtemp(join(tmpdir(), "pgwb-query-export-"));
    const file = join(directory, "query.json");
    const field = {
      name: "value",
      tableID: 0,
      columnID: 0,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: "text",
    };
    const full = "x".repeat(70_000);
    batches.held = [
      { rows: [[full], ...Array.from({ length: 4_999 }, () => ["small"])], fields: [field] },
      { rows: [["last"]], fields: [field] },
    ];

    await expect(
      exportAllRows({
        target: { fsPath: file } as vscode.Uri,
        choice: choice("json"),
        sql: "select value from source",
        title: "query-result",
        openClient: async () => ({}) as never,
      }),
    ).resolves.toBe(5_001);

    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written).toHaveLength(5_001);
    expect(written[0].value).toHaveLength(70_000);
    expect(written.at(-1)).toEqual({ value: "last" });
    expect(batches.closed).toHaveBeenCalledOnce();
  });
});
