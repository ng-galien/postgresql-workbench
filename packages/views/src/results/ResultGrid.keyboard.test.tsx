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

  it("keeps exactly one cell in the tab order, and remembers which", () => {
    const markup = renderToStaticMarkup(<ResultGrid payload={table()} />);
    const cells = [...markup.matchAll(/<td[^>]*>/gu)].map(([tag]) => tag);

    // Roving tabindex: one Tab reaches the grid, the arrows move inside it. The scrollbar keeps
    // its own stop, which is why only the cells are counted here.
    const reachable = cells.filter((tag) => tag.includes('tabindex="0"'));
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toContain('data-row="0"');
    expect(reachable[0]).toContain('data-column="0"');
    expect(cells.every((tag) => /tabindex="(?:0|-1)"/u.test(tag))).toBe(true);
  });
});
