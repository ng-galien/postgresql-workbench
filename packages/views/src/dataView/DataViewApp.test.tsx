// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DataViewApp } from "./DataViewApp.js";
import { dataViewHarness, dataViewPayload, readyDataView } from "./dataViewHarness.js";

/**
 * The Data View reaches VS Code only through its messaging port, so the whole view runs in a plain
 * DOM: no Extension Host, no Electron. What those cover is the message crossing the wire; what the
 * view does with one is covered here, in milliseconds instead of minutes.
 */
afterEach(cleanup);

/** The drag a reader performs, as the DOM reports it: start on one item, drop on another. */
function dragOnto(source: Element, target: Element) {
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: () => {}, getData: () => "" };
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

/** Opens the view and hands it a state, the way the host answers `data-view/ready`. */
function open(state = readyDataView()) {
  const harness = dataViewHarness();
  render(<DataViewApp messaging={harness} />);
  act(() => harness.deliver({ type: "data-view/state", state }));
  return harness;
}

describe("the Data View", () => {
  it("announces itself before the host sends anything", () => {
    const harness = dataViewHarness();
    render(<DataViewApp messaging={harness} />);

    expect(harness.posted).toEqual([{ type: "data-view/ready" }]);
    expect(screen.getByText("Opening the Data View…")).toBeDefined();
  });

  it("shows the rows the host sent", () => {
    open();

    const grid = screen.getByRole("grid");
    expect(within(grid).getByText("Espresso")).toBeDefined();
    expect(within(grid).getByText("Ristretto")).toBeDefined();
    // Between the two arrows the count is said in as few characters as it can be: paging must not
    // move them, so what is there never changes width.
    expect(document.querySelector(".result-navigation-summary")?.textContent).toBe("2");
  });

  it("asks the host to sort when a column header is activated", async () => {
    const harness = open();

    await userEvent.click(screen.getByTitle(/^Sort by name/u));

    expect(harness.lastPost("data-view/sort")).toEqual({
      type: "data-view/sort",
      sorts: [{ column: "name", direction: "ascending" }],
    });
  });

  it("forgets a selected editable row before sorting replaces the page", async () => {
    const state = readyDataView({
      editability: {
        tables: [
          {
            tableOid: 1,
            schema: "shop",
            name: "product",
            keyOrdinals: [0],
            keyColumns: ["id"],
            keyTypes: ["integer"],
            referencedBy: [],
          },
        ],
        columns: [
          { editable: false, reason: "Identity value (primary key)." },
          { editable: true, tableOid: 1, column: "name", dataType: "text", editor: "text" },
        ],
        requiredOrdinals: [],
        technicalOrdinals: [0],
      },
    });
    const harness = open(state);
    await userEvent.click(screen.getByRole("button", { name: "Edit mode" }));
    fireEvent.mouseDown(screen.getByTitle(/^Row 1 /u));
    expect(screen.getByText("1 row selected")).toBeDefined();

    await userEvent.click(screen.getByTitle(/^Sort by name/u));
    expect(document.querySelector(".edit-bar-selection")?.textContent).toBe("Nothing selected");
    expect(document.querySelector<HTMLButtonElement>(".edit-bar-button.remove")?.disabled).toBe(
      true,
    );
    expect(harness.lastPost("data-view/sort")?.sorts).toEqual([
      { column: "name", direction: "ascending" },
    ]);
  });

  it("cycles a column through ascending, descending, and no order at all", async () => {
    const harness = open();

    await userEvent.click(screen.getByTitle(/^Sort by name/u));
    act(() =>
      harness.deliver({
        type: "data-view/state",
        state: readyDataView({
          query: {
            ...readyDataView().query,
            orderBy: [{ text: "name ASC", direction: "ascending", column: "name" }],
          },
        }),
      }),
    );
    await userEvent.click(screen.getByTitle(/^Sort by name/u));

    expect(harness.lastPost("data-view/sort")?.sorts).toEqual([
      { column: "name", direction: "descending" },
    ]);
  });

  it("reports what the host says went wrong, without losing the view", () => {
    open(readyDataView({ status: "error", message: 'relation "shop.gone" does not exist' }));

    expect(document.querySelector(".data-view-statusline-text")?.textContent).toContain(
      "does not exist",
    );
  });

  it("says so when the query returned no rows", () => {
    open(readyDataView({ payload: dataViewPayload([]) }));

    expect(document.querySelector(".result-navigation-summary")?.textContent).toBe("0");
  });

  it("disables paging without offering Cancel loading while row changes are applied", () => {
    open(readyDataView({ busy: false, applying: true }));

    expect(screen.queryByRole("button", { name: "Cancel loading" })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next page" }).disabled).toBe(
      true,
    );
  });

  it("sends the filter the reader typed", async () => {
    const harness = open();

    const filter = screen.getByRole("combobox", { name: /where/iu });
    await userEvent.type(filter, "name = 'Espresso'");
    await userEvent.keyboard("{Enter}");

    expect(harness.lastPost("data-view/filter")).toEqual({
      type: "data-view/filter",
      text: "name = 'Espresso'",
    });
  });

  it("removes a table from the query", async () => {
    const harness = open();

    await userEvent.click(screen.getByRole("button", { name: /Remove shop\.product/u }));

    // The badge names the relation it removes: badges can be reordered, so a position posted with
    // the click may no longer be the one the reader pointed at.
    expect(harness.lastPost("data-view/remove-table")).toEqual({
      type: "data-view/remove-table",
      schema: "shop",
      name: "product",
    });
  });

  it("names where the rows come from once, and lets the badge do it when there is one", () => {
    /*
     * A view opened from a Scratchpad result carries the statement as its label. Beside a badge
     * that names the table in full and can take it out of the query, that label said the same
     * thing again in a line too short to finish it — and the editor tab already carries it.
     */
    const fromStatement = {
      kind: "sql" as const,
      connectionId: "demo",
      database: "demo",
      sql: "SELECT product.id, product.name FROM shop.product AS product",
      label: "SELECT product.id, product.name FROM shop.product AS product",
    };
    open(readyDataView({ source: fromStatement }));

    expect(screen.getByText("product")).toBeDefined();
    expect(document.querySelector(".data-view-title")).toBeNull();
    cleanup();

    // With no badge to name it, the label is all the reader has, so it stands in.
    open(
      readyDataView({
        source: fromStatement,
        projection: { tables: [], columnTable: [] },
      }),
    );

    expect(document.querySelector(".data-view-title")?.textContent).toBe(fromStatement.label);
  });

  it("offers no query rewriting when the SQL could not be analyzed", () => {
    const unstructured = readyDataView();
    open({
      ...unstructured,
      query: {
        ...unstructured.query,
        structured: false,
        problem: "a CTE the engine cannot rewrite",
      },
    });

    // Nothing that would rewrite the SQL is offered: the reader still reads, and edits nothing.
    expect(
      screen.getByTitle(/Add a column or a related table/u).getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("moves a table onto another position by dragging it there", () => {
    const harness = open(
      readyDataView({
        projection: {
          tables: [
            { tableOid: 1, schema: "shop", name: "product", accent: 0 },
            { tableOid: 2, schema: "shop", name: "customer", accent: 1 },
          ],
          columnTable: [0, 1],
        },
      }),
    );
    const [product, customer] = screen.getAllByTitle(/its columns carry the same accent/u);

    dragOnto(product, customer);

    expect(harness.lastPost("data-view/reorder-table")).toEqual({
      type: "data-view/reorder-table",
      from: 0,
      to: 1,
    });
  });

  it("shows the SQL it runs, in the view, and hides it again", async () => {
    open();
    const toggle = screen.getByRole("button", { name: /Show the SQL/u });

    await userEvent.click(toggle);

    const panel = screen.getByRole("region", { name: "Query SQL" });
    expect(within(panel).getByText(/shop\.product/u)).toBeDefined();

    await userEvent.click(within(panel).getByRole("button", { name: /Hide the SQL/u }));
    expect(screen.queryByRole("region", { name: "Query SQL" })).toBeNull();
  });

  it("offers one control for the SQL, not two", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: /More actions/u }));

    // The panel is the toolbar's; the menu keeps only what still needs an editor.
    expect(screen.queryByRole("menuitem", { name: /Show SQL/u })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Edit in a SQL editor/u })).toBeDefined();
  });
});
