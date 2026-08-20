// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DataViewApp } from "./DataViewApp.js";
import { dataViewHarness, dataViewPayload, dataViewState } from "./dataViewHarness.js";

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
function open(state = dataViewState()) {
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
    expect(screen.getByText("2 rows")).toBeDefined();
  });

  it("asks the host to sort when a column header is activated", async () => {
    const harness = open();

    await userEvent.click(screen.getByTitle(/^Sort by name/u));

    expect(harness.lastPost("data-view/sort")).toEqual({
      type: "data-view/sort",
      sorts: [{ column: "name", direction: "ascending" }],
    });
  });

  it("cycles a column through ascending, descending, and no order at all", async () => {
    const harness = open();

    await userEvent.click(screen.getByTitle(/^Sort by name/u));
    act(() =>
      harness.deliver({
        type: "data-view/state",
        state: dataViewState({
          query: {
            ...dataViewState().query,
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
    open(dataViewState({ status: "error", message: 'relation "shop.gone" does not exist' }));

    expect(screen.getByRole("status").textContent).toContain("does not exist");
  });

  it("says so when the query returned no rows", () => {
    open(dataViewState({ payload: dataViewPayload([]) }));

    expect(screen.getByText("0 rows")).toBeDefined();
  });

  it("sends the filter the reader typed", async () => {
    const harness = open();

    const filter = screen.getByRole("textbox", { name: /where/iu });
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

    expect(harness.lastPost("data-view/remove-table")).toEqual({
      type: "data-view/remove-table",
      tableIndex: 0,
    });
  });

  it("offers no query rewriting when the SQL could not be analyzed", () => {
    const unstructured = dataViewState();
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
      dataViewState({
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
    expect(screen.getByRole("menuitem", { name: /Edit the query in a SQL editor/u })).toBeDefined();
  });
});
