import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";
import { SqlResultView } from "./SqlResultView.js";

function payload(overrides: Partial<SqlNotebookResultPayload> = {}): SqlNotebookResultPayload {
  return {
    version: 2,
    binding: {
      serverId: "test-server",
      serverName: "Test PostgreSQL",
      database: "testdb",
    },
    command: "SELECT",
    columns: [
      { name: "id", dataTypeId: 23, typeName: "int4" },
      { name: "details", dataTypeId: 3802, typeName: "jsonb" },
    ],
    rows: [
      [
        { kind: "number", value: "7" },
        { kind: "json", value: '{"ready":true}' },
      ],
    ],
    rowCount: 1,
    capturedRowCount: 1,
    durationMs: 4,
    truncated: false,
    truncationReasons: [],
    ...overrides,
  };
}

describe("SqlResultView", () => {
  it("renders scalar cells as text and inspectable values as buttons", () => {
    const html = renderToStaticMarkup(<SqlResultView payload={payload()} />);

    expect(html).toContain("Result binding: Test PostgreSQL · testdb");
    expect(html).toContain('<span class="cell-value">7</span>');
    expect(html).toContain('class="cell-value inspectable"');
    expect(html).toContain("Inspect details");
    expect(html).toContain("aria-controls=");
    expect(html).toContain("Copy TSV");
    expect(html).not.toContain("aria-sort");
    expect(html).toContain("Sort loaded rows by id");
    expect(html).not.toContain("Inspect id");
    expect(html).toContain('role="scrollbar"');
    expect(html).toContain('aria-label="Vertical result scroll"');
  });

  it("renders cursor navigation and an unknown total", () => {
    const html = renderToStaticMarkup(
      <SqlResultView
        payload={payload({
          rowCount: undefined,
          capturedRowCount: 200,
          navigation: {
            sessionId: "session-1",
            mode: "paged",
            pageIndex: 0,
            pageSize: 200,
            pageStart: 1,
            pageEnd: 200,
            loadedRowCount: 201,
            cacheStart: 1,
            hasPrevious: false,
            hasNext: true,
            canLoadAll: true,
          },
        })}
        messaging={{ postMessage() {}, subscribe: () => () => {} }}
      />,
    );

    expect(html).toContain("Rows 1–200 · more available");
    // The navigation is the shared control: icons, named for anyone who cannot see them.
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('aria-label="Load every remaining row');
    expect(html).toContain("may use significant memory");
  });

  it("virtualizes a large loaded result", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => [
      { kind: "number" as const, value: String(index + 1) },
      { kind: "text" as const, value: `row-${index + 1}` },
    ]);
    const html = renderToStaticMarkup(
      <SqlResultView
        payload={payload({
          rows,
          rowCount: 1_000,
          capturedRowCount: 1_000,
        })}
      />,
    );

    expect(html).toContain('aria-rowcount="1001"');
    expect(html).toContain("row-1");
    expect(html).not.toContain("row-1000");
    expect(html).toContain("--result-spacer-height");
  });

  it("renders command-only and truncated result states", () => {
    const commandOnly = renderToStaticMarkup(
      <SqlResultView payload={payload({ columns: [], rows: [], rowCount: 0 })} />,
    );
    const truncated = renderToStaticMarkup(
      <SqlResultView
        payload={payload({
          rowCount: 5_000,
          capturedRowCount: 200,
          truncated: true,
          truncationReasons: ["rows"],
        })}
      />,
    );

    expect(commandOnly).toContain("SELECT completed without a row set.");
    expect(commandOnly).not.toContain("Copy TSV");
    expect(truncated).toContain("Preview truncated");
    expect(truncated).toContain("200 of 5000 rows");
    expect(truncated).toContain('title="rows"');
  });
});
