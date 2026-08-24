// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";
import type { SqlNotebookRendererResponse } from "./payload.js";
import { SqlResultView } from "./SqlResultView.js";

afterEach(cleanup);

function payload(overrides: Partial<SqlNotebookResultPayload> = {}): SqlNotebookResultPayload {
  return {
    version: 2,
    resultId: "result-1",
    binding: {
      connectionId: "test-connection",
      connectionName: "Test PostgreSQL",
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
  it("renders every value as a value, whatever shape it is", () => {
    const html = renderToStaticMarkup(<SqlResultView payload={payload()} />);

    expect(html).toContain("Result binding: Test PostgreSQL · testdb");
    expect(html).toContain('<span class="cell-value">7</span>');
    /*
     * A document is a value like any other in a row: it is not dressed as a link, and clicking it
     * opens nothing. Reading one whole is the value panel's business, and that panel is opened by
     * the reader rather than by the cell deciding on their behalf.
     */
    expect(html).not.toContain("inspectable");
    expect(html).not.toContain("Inspect details");
    expect(html).not.toContain("Copy TSV");
    expect(html).not.toContain("aria-sort");
    expect(html).toContain("Sort displayed rows by id");
    expect(html).not.toContain("Inspect id");
    expect(html).toContain('role="scrollbar"');
    expect(html).toContain('aria-label="Vertical result scroll"');
  });

  it("renders LIMIT/OFFSET page navigation and an unknown total", () => {
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
            hasPrevious: false,
            hasNext: true,
            canLoadAll: true,
          },
        })}
        messaging={{ postMessage() {}, subscribe: () => () => {} }}
      />,
    );

    expect(html).toContain("1–200 / ?");
    // The navigation is the shared control: icons, named for anyone who cannot see them.
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('aria-label="Load every remaining row');
    expect(html).toContain("may use significant memory");
  });

  it("shows the complete value under the grid cursor", async () => {
    render(<SqlResultView payload={payload()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Show the value under the cursor, whole" }),
    );

    const inspector = screen.getByRole("complementary", { name: "Value of id" });
    expect(within(inspector).getByText("7")).toBeDefined();
  });

  it("keeps a full inspected host value instead of repeatedly restoring the display preview", async () => {
    const postMessage = vi.fn();
    let listener: ((message: SqlNotebookRendererResponse) => void) | undefined;
    render(
      <SqlResultView
        payload={payload({
          rows: [
            [
              { kind: "number", value: "7", truncated: true },
              { kind: "json", value: '{"ready":true}' },
            ],
          ],
          truncated: true,
          truncationReasons: ["cell"],
        })}
        messaging={{
          postMessage,
          subscribe: (next) => {
            listener = next;
            return () => {};
          },
        }}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Show the value under the cursor, whole" }),
    );
    const request = postMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      type: "sql-result/inspect",
      resultId: "result-1",
      row: 0,
      ordinal: 0,
    });
    listener?.({
      type: "sql-result/inspected",
      requestId: request.requestId,
      resultId: "result-1",
      cell: { kind: "number", value: "70000-full" },
    });

    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Value of id" }).textContent).toContain(
        "70000-full",
      ),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("exports held Scratchpad rows by reference in result-safe shapes", async () => {
    const postMessage = vi.fn();
    render(
      <SqlResultView payload={payload()} messaging={{ postMessage, subscribe: () => () => {} }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Export rows to a file…" }));
    const panel = screen.getByRole("region", { name: "Export rows" });
    expect(screen.queryByRole("dialog", { name: "Export rows" })).toBeNull();
    expect(within(panel).getByRole("radio", { name: /The selection/u })).toBeDefined();
    expect(within(panel).getByRole("radio", { name: /The rows loaded/u })).toBeDefined();
    expect(within(panel).queryByRole("radio", { name: /Entire query/u })).toBeNull();
    expect(within(panel).queryByRole("radio", { name: "SQL" })).toBeNull();

    await userEvent.click(within(panel).getByRole("radio", { name: /^JSON\b/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Export" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "sql-result/export",
      resultId: "result-1",
      title: "select-result",
      choice: {
        format: "json",
        header: true,
        nullAs: "empty",
        delimiter: ",",
        spreadsheetSafe: true,
        finalNewline: true,
        createTable: false,
      },
      scope: "loaded",
      page: { start: 1, length: 1 },
    });
  });

  it("exports a sorted selection against the same local order as the grid", async () => {
    const postMessage = vi.fn();
    render(
      <SqlResultView
        payload={payload({
          rows: [
            [
              { kind: "number", value: "2" },
              { kind: "text", value: "two" },
            ],
            [
              { kind: "number", value: "1" },
              { kind: "text", value: "one" },
            ],
          ],
          rowCount: 2,
          capturedRowCount: 2,
        })}
        messaging={{ postMessage, subscribe: () => () => {} }}
      />,
    );

    await userEvent.click(screen.getByTitle("Sort displayed rows by id"));
    fireEvent.mouseDown(document.querySelector('[data-row="0"][data-column="0"]') as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Export rows to a file…" }));
    const panel = screen.getByRole("region", { name: "Export rows" });
    await userEvent.click(within(panel).getByRole("radio", { name: /The selection/u }));
    await userEvent.click(within(panel).getByRole("button", { name: "Export" }));

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "sql-result/export",
        scope: "selection",
        page: { start: 1, length: 2 },
        sort: { columnIndex: 0, direction: "ascending" },
        selection: { from: 0, to: 0, ordinals: [0] },
      }),
    );
  });

  it("names and warns about the replayed entire-query scope", async () => {
    const postMessage = vi.fn();
    render(
      <SqlResultView
        payload={payload({ statement: "select * from volatile_source()" })}
        messaging={{ postMessage, subscribe: () => () => {} }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Export rows to a file…" }));
    const panel = screen.getByRole("region", { name: "Export rows" });
    await userEvent.click(within(panel).getByRole("radio", { name: /Entire query/u }));
    expect(within(panel).getByRole("note").textContent).toMatch(/side effects will execute again/u);
    await userEvent.click(within(panel).getByRole("button", { name: "Export" }));
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sql-result/export", scope: "all" }),
    );
  });

  it("moves focus into the inline export panel and returns it to the opener", async () => {
    const escapedPanel = vi.fn();
    document.addEventListener("keydown", escapedPanel);
    render(
      <SqlResultView
        payload={payload()}
        messaging={{ postMessage() {}, subscribe: () => () => {} }}
      />,
    );
    const opener = screen.getByRole("button", { name: "Export rows to a file…" });
    await userEvent.click(opener);
    const panel = screen.getByRole("region", { name: "Export rows" });
    expect(document.activeElement).toBe(panel);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(escapedPanel).not.toHaveBeenCalled();
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    document.removeEventListener("keydown", escapedPanel);
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
    expect(truncated).toContain("Preview truncated");
    expect(truncated).toContain("200 of 5000 rows");
    expect(truncated).toContain('title="rows"');
  });
});
