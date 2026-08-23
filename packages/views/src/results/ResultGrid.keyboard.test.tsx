import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { ResultGrid } from "./ResultGrid.js";

function table(): ResultTable {
  return {
    columns: [
      { name: "id", dataTypeId: 23, typeName: "int4" },
      { name: "city", dataTypeId: 25, typeName: "text" },
    ],
    rows: [
      [
        { kind: "number", value: "1" },
        { kind: "text", value: "Genève" },
      ],
      [
        { kind: "number", value: "2" },
        { kind: "text", value: "Lyon" },
      ],
    ],
    rowCount: 2,
    capturedRowCount: 2,
    truncated: false,
    truncationReasons: [],
  };
}

describe("result grid keyboard contract", () => {
  it("is a grid whose cells are all reachable", () => {
    const markup = renderToStaticMarkup(<ResultGrid payload={table()} />);

    // `grid` is the interactive role; the row and cell roles come implicitly from the table.
    expect(markup).toContain('role="grid"');
    expect([...markup.matchAll(/<td[^>]*data-row=/gu)]).toHaveLength(4);
  });

  it("keeps one focus stop for the whole grid, and points it at the cursor", () => {
    const markup = renderToStaticMarkup(<ResultGrid payload={table()} />);
    const cells = [...markup.matchAll(/<td[^>]*>/gu)].map(([tag]) => tag);

    /*
     * One Tab reaches the grid and the arrows move inside it. The stop is the clipboard proxy
     * rather than a cell, because a cell holds no text and so a browser would raise neither copy
     * nor paste on it. `aria-activedescendant` is what says where the cursor is instead.
     */
    const proxy = markup.match(/<textarea[^>]*class="grid-clipboard"[^>]*>/u)?.[0] ?? "";
    expect(proxy).not.toBe("");
    expect(proxy).toContain("aria-activedescendant=");
    expect(cells.some((tag) => tag.includes("tabindex"))).toBe(false);

    // The cursor starts on the first cell, and that cell is the one the proxy names.
    const named = /aria-activedescendant="([^"]+)"/u.exec(proxy)?.[1];
    expect(cells.find((tag) => tag.includes(`id="${named}"`))).toContain('data-row="0"');
  });
});
