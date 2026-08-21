import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ResultTable } from "../../views/testing/ResultTable.js";
import { EXPORTS } from "./playwright.config.js";

/**
 * The Data View journey, against the real engines and from nothing: PostgreSQL answers the rows,
 * Code Moniker parses the SQL, the language server proposes, and the composition engine plans the
 * joins from the database's own foreign keys. A view opens empty, the first relation added becomes
 * the base, and everything else composes onto it.
 */

/** Opens an empty view: the shell is one running application, so each scenario starts it over. */
async function openEmpty(page: Page) {
  await page.request.post("/reset");
  await page.goto("/");
  await expect(page.getByText("The query is empty")).toBeVisible();
}

/** Adds a relation from the additions menu, and waits for what it composed to load. */
async function add(page: Page, relation: string): Promise<ResultTable> {
  await page.getByTitle(/Add (the first table|a column or a related table)/u).click();
  await page.getByTitle(new RegExp(`^(Start the query with|JOIN) ${relation}(\\s|$)`, "u")).click();
  await expect(page.getByTitle(new RegExp(`^${relation} — its columns`, "u"))).toBeVisible();
  return new ResultTable(page);
}

/** Opens the columns menu, whose control names how many columns are hidden right now. */
async function openColumns(page: Page) {
  await page.getByTitle(/^(Show or hide columns|Columns \()/u).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** Turns editing on: the gutter, the edit bar and cell editing all follow that one control. */
async function enterEditMode(page: Page) {
  await page.getByTitle("Edit mode", { exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Row editing" })).toBeVisible();
}

/** Selects whole rows the way a reader does: in the gutter, extending with shift. */
/** Puts text on the clipboard the reader will paste from. */
async function putOnClipboard(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

/** Reads back what the grid put on the clipboard. */
function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Opens the export dialog from the toolbar. */
async function openExport(page: Page) {
  await page.getByRole("button", { name: /Export rows to a file/u }).click();
  await expect(page.getByRole("dialog", { name: "Export rows" })).toBeVisible();
}

async function selectRows(page: Page, first: number, last = first) {
  const gutters = page.locator("tbody th.row-gutter");
  await gutters.nth(first).click();
  if (last !== first) await gutters.nth(last).click({ modifiers: ["Shift"] });
}

/** The edit bar's own controls, by the words on them. */
function editBar(page: Page) {
  const bar = page.getByRole("toolbar", { name: "Row editing" });
  return {
    selection: bar.locator(".edit-bar-selection"),
    add: bar.getByRole("button", { name: /Add row/u }),
    remove: bar.getByRole("button", { name: /Delete/u }),
    changes: bar.locator(".edit-bar-button.count"),
    apply: bar.getByRole("button", { name: /Apply/u }),
  };
}

/** The SQL the view says it is running, read line by line out of its panel. */
async function runningSql(page: Page): Promise<string> {
  const panel = page.getByRole("region", { name: "Query SQL" });
  if (!(await panel.isVisible())) await page.getByTitle(/Show the SQL/u).click();
  return (await panel.locator(".postgres-source-line-code").allInnerTexts()).join("\n");
}

test("opens with nothing, and offers every table as a first one", async ({ page }) => {
  await openEmpty(page);

  await page.getByTitle("Add the first table of the query").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByTitle("Start the query with shop.product", { exact: true })).toBeVisible();
  await expect(
    menu.getByTitle("Start the query with shop.customer", { exact: true }),
  ).toBeVisible();
  // Nothing is reachable from nothing, so every table is offered as a starting point — under the
  // schema it belongs to, because a database holds more relations than one list can show.
  await expect(menu.getByText("shop", { exact: true })).toBeVisible();
  await expect(menu.getByText("public", { exact: true })).toBeVisible();
});

test("makes the first relation the base of the query", async ({ page }) => {
  await openEmpty(page);

  const rows = await add(page, "shop.product");

  await expect(rows.cellsWithText("Saumon fumé")).toHaveCount(1);
  await expect(rows.summary("4")).toBeVisible();
  expect(await runningSql(page)).toMatch(/FROM\s+shop\.product AS product/u);
});

test("composes a table by keyboard alone: type, walk down, press Enter", async ({ page }) => {
  await openEmpty(page);
  await page.getByTitle(/Add (the first table|a column or a related table)/u).click();

  // The filter has the focus when it opens, so a reader types straight into it.
  await page.keyboard.type("order");
  const proposals = page.locator(".addition-item");
  await expect(proposals.first()).toContainText("shop.order_line");

  // The walk starts on the first proposal, and wraps rather than stopping — never a dead press.
  await expect(proposals.first()).toHaveClass(/highlighted/u);
  await page.keyboard.press("ArrowUp");
  await expect(proposals.last()).toHaveClass(/highlighted/u);
  await page.keyboard.press("ArrowDown");
  await expect(proposals.first()).toHaveClass(/highlighted/u);

  // The arrows move the highlight, not the caret: a one-line filter has nowhere for them to go.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(proposals.nth(2)).toHaveClass(/highlighted/u);
  const chosen = (await proposals.nth(2).locator(".addition-label").textContent()) ?? "";

  await page.keyboard.press("Enter");

  await expect(page.getByTitle(new RegExp(`^${chosen} — its columns`, "u"))).toBeVisible();
});

test("joins a related table on the key the planner chose", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await add(page, "shop.brand");

  // Coherent means: the JOIN names the foreign key that actually relates the two.
  const sql = await runningSql(page);
  expect(sql).toMatch(/JOIN\s+shop\.brand AS brand/u);
  expect(sql).toMatch(/ON\s+product\.brand_id = brand\.id/u);
});

test("removes a table and everything that referenced it", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await add(page, "shop.brand");

  await page.getByRole("button", { name: "Remove shop.brand" }).click();

  await expect(page.getByTitle(/^shop\.brand — its columns/u)).toBeHidden();
  const sql = await runningSql(page);
  expect(sql).not.toContain("shop.brand");
  expect(sql).not.toContain("brand.id");
});

test("empties the query when its last table is removed, and starts over", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await page.getByRole("button", { name: "Remove shop.product" }).click();

  await expect(page.getByText("The query is empty")).toBeVisible();
  // The way out of the empty state is the control the message names.
  await expect(page.getByTitle("Add the first table of the query")).toBeEnabled();
  const rows = await add(page, "shop.customer");
  await expect(rows.summary("3")).toBeVisible();
});

test("sorts on a column, and says so in the SQL", async ({ page }) => {
  await openEmpty(page);
  const rows = await add(page, "shop.product");

  await page.getByTitle(/^Sort by price/u).click();

  await expect.poll(async () => runningSql(page)).toMatch(/ORDER BY\s+product\.price ASC/u);
  // Cheapest first: the rows really came back sorted, not just the SQL.
  await expect(rows.cell(0, 2)).toHaveText("6.40");
});

test("turns a criterion over when it is pressed, with nothing else to reach for", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await page.getByTitle(/^Sort by price/u).click();

  const criterion = page.locator(".data-view-order .data-view-clause").first();
  // The criterion is the control: no second icon beside it doing what pressing it does.
  await expect(criterion.getByRole("button", { name: /Invert/u })).toHaveCount(0);

  await criterion.getByRole("button", { name: /Sorted ascending/u }).click();

  await expect.poll(async () => runningSql(page)).toMatch(/product\.price DESC/u);
  await expect(criterion.getByRole("button", { name: /Sorted descending/u })).toBeVisible();
});

test("writes a NULLS ordering only where it is not what PostgreSQL would do", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await page.getByTitle(/^Sort by price/u).click();

  /*
   * Ascending puts NULLs last on its own, so nothing is written — and the criterion says where
   * they are all the same, because a reader should not have to know the rule to read the query.
   */
  await expect.poll(async () => runningSql(page)).toMatch(/product\.price ASC/u);
  expect(await runningSql(page)).not.toMatch(/NULLS/iu);
  const nulls = page.locator(".data-view-clause-nulls").first();
  await expect(nulls).toHaveAttribute("title", /NULLs last — what PostgreSQL does/u);

  await nulls.click();

  await expect.poll(async () => runningSql(page)).toMatch(/price ASC NULLS FIRST/u);
  await expect(nulls).toHaveClass(/overridden/u);

  // And pressing it again gives PostgreSQL its say back rather than writing the default out.
  await nulls.click();

  await expect.poll(async () => runningSql(page)).not.toMatch(/NULLS/iu);
  await expect(nulls).not.toHaveClass(/overridden/u);
});

test("filters on a WHERE the reader types", async ({ page }) => {
  await openEmpty(page);
  const rows = await add(page, "shop.product");

  const filter = page.getByRole("combobox", { name: /where/iu });
  await filter.fill("product.stock = 0");
  await filter.press("Enter");

  await expect(rows.cellsWithText("Truite fumée")).toHaveCount(1);
  await expect(rows.cellsWithText("Saumon fumé")).toHaveCount(0);
  expect(await runningSql(page)).toContain("product.stock = 0");
});

test("reads the SQL in the view, and closes it again", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await page.getByTitle(/Show the SQL/u).click();
  const panel = page.getByRole("region", { name: "Query SQL" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("SELECT")).toBeVisible();

  await panel.getByTitle(/Hide the SQL/u).click();
  await expect(panel).toBeHidden();
});

test("hides a column without dropping it from the query", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await openColumns(page);
  const column = page.getByRole("menuitemcheckbox", { name: "description" });
  await expect(column).toHaveAttribute("aria-checked", "true");
  await column.click();
  // The menu stays open, because hiding several columns is one gesture; Escape dismisses it.
  await expect(column).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await expect(page.getByRole("columnheader", { name: /description/u })).toBeHidden();
  // Still projected: the rows stay identified, which is what makes them editable.
  expect(await runningSql(page)).toContain("product.description");
});

test("proposes what the language server knows, not what the view already shows", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await page.getByRole("combobox", { name: /where/iu }).fill("product.");

  const proposals = page.getByRole("listbox", { name: /completion/iu });
  await expect(proposals).toBeVisible();
  // The type comes from the catalog through the server; the view's own columns carry no type.
  await expect(proposals.getByText("numeric(8,2)")).toBeVisible();
  await expect(proposals.getByText("brand_id")).toBeVisible();
});

test("pages a relation too large to load at once, and loads the rest on demand", async ({
  page,
}) => {
  await openEmpty(page);
  const rows = await add(page, "shop.inventory_movement");

  /*
   * A movement table is the one that really grows: the first page is a page, not the whole thing.
   * Where the reader is is said between the two arrows, in a slot that keeps its width — so what
   * is asserted is the text of that slot and, just as much, that the arrows do not move.
   */
  const summary = page.locator(".result-navigation-summary");
  const nextArrow = page.locator('.data-view-rows-line button[title="Next page"]');
  const where = () => nextArrow.evaluate((b) => Math.round(b.getBoundingClientRect().x));
  await expect(summary).toHaveText("1–200 / ?");
  const arrowAt = await where();

  await rows.next();
  await expect(summary).toHaveText("201–400 / ?");
  expect(await where()).toBe(arrowAt);
  await rows.previous();
  await expect(summary).toHaveText("1–200 / ?");
  expect(await where()).toBe(arrowAt);

  await rows.loadAll();
  // The whole table, however many rows the seed holds and whatever a reader has since deleted:
  // what matters is that nothing is left to fetch.
  await expect(summary).toHaveText(/^\d+$/u, { timeout: 20_000 });
});

test("hides the key columns a reader has no use for, and offers them back", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.inventory_movement");

  // Identity and relationship values are what a reader who does not write SQL never asked for.
  await expect(page.getByRole("columnheader", { name: /^id/u })).toBeHidden();
  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toBeHidden();
  await expect(page.getByRole("columnheader", { name: /movement_type/u })).toBeVisible();
  expect(await runningSql(page)).toContain("inventory_movement.id");

  await openColumns(page);
  await page.getByRole("menuitem", { name: /^Show \d+ key columns$/u }).click();

  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toBeVisible();
  await page.getByRole("menuitem", { name: /^Hide \d+ key columns$/u }).click();
  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toBeHidden();
});

test("removes the relation the reader points at, whichever one it is", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await add(page, "shop.brand");

  // The first table added is only the first one added: nothing makes it undeletable.
  await page.getByRole("button", { name: "Remove shop.product" }).click();

  await expect(page.getByTitle(/^shop\.product — its columns/u)).toBeHidden();
  await expect(page.getByTitle(/^shop\.brand — its columns/u)).toBeVisible();
  const sql = await runningSql(page);
  expect(sql).toMatch(/FROM\s+shop\.brand AS brand/u);
  expect(sql).not.toContain("shop.product");
});

test("removes a joined relation from the FROM clause, not only from the projection", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.inventory");
  await add(page, "shop.product");

  await page.getByRole("button", { name: "Remove shop.product" }).click();

  const sql = await runningSql(page);
  expect(sql).not.toContain("JOIN");
  expect(sql).not.toContain("shop.product");
  expect(sql).toMatch(/FROM\s+shop\.inventory AS inventory/u);
});

test("brings the joined relation's own columns into the projection", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.inventory");

  await add(page, "shop.product");

  // A JOIN that projects nothing of what it joined is a JOIN the reader cannot see or remove.
  await expect(page.getByRole("columnheader", { name: /^name/u })).toBeVisible();
  const sql = await runningSql(page);
  expect(sql).toContain("product.name");
  expect(sql).toMatch(/JOIN\s+shop\.product AS product/u);
});

test("removes the right relation after the tables have been reordered", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.inventory");
  await add(page, "shop.product");

  // Moving a table moves its columns, and the badges move with them. The relation a reader then
  // points at is the one that goes: the click carries its name, not the place it used to hold.
  const [inventory, product] = await page.getByTitle(/its columns carry the same accent/u).all();
  if (!inventory || !product) throw new Error("expected two table badges");
  await inventory.dragTo(product);
  await expect(page.locator(".data-view-table-badge").first()).toContainText("product");

  await page.getByRole("button", { name: "Remove shop.product" }).click();

  const sql = await runningSql(page);
  expect(sql).not.toContain("shop.product");
  expect(sql).not.toContain("product.name");
  expect(sql).toContain("inventory.quantity");
  expect(sql).toMatch(/FROM\s+shop\.inventory AS inventory/u);
});

test("puts what is reached for often within reach, and the rest out of the way", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.sales_order");

  /*
   * A control sits with what it acts on. The bar at the top is about the view and the query; the
   * line above the rows is about the rows, so walking them and opening them for writing are there
   * — not beside the connection, which they have nothing to do with.
   */
  const often = page.locator(".toolbar-side-often");
  const seldom = page.locator(".toolbar-side-seldom");
  const rows = page.locator(".data-view-rows-line");
  await expect(often.getByTitle("Refresh")).toBeVisible();
  await expect(often.getByTitle(/^(Show or hide columns|Columns \()/u)).toBeVisible();
  await expect(seldom.getByTitle(/the SQL$/u)).toBeVisible();
  await expect(seldom.getByTitle("More actions")).toBeVisible();

  await expect(rows.getByTitle(/^Next page$/u)).toBeVisible();
  await expect(rows.getByTitle(/^Edit mode$/u)).toBeVisible();
  // And nothing about the rows is left in the bar that is not about them.
  await expect(often.getByTitle(/^Next page$/u)).toHaveCount(0);
  await expect(
    page.getByRole("toolbar", { name: "Data view actions" }).getByTitle(/^Edit mode$/u),
  ).toHaveCount(0);

  // A stop is shown while there is a load to stop, and takes no room the rest of the time.
  await expect(page.getByTitle("Cancel loading")).toHaveCount(0);
});

test("moves rows in and out through dialogs of their own", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.sales_order");

  // Six near-identical export lines used to bury everything else in the actions menu, and a
  // seventh copied the loaded rows as TSV — which the export panel and Ctrl+C both do better.
  await page.getByTitle("More actions").click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(2);
  await page.keyboard.press("Escape");

  await page.getByTitle("Export rows to a file…").click();
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  // Which rows, which shape, and what that gives — three questions, not six near-identical lines.
  await expect(dialog.getByRole("radio", { name: /The rows loaded/u })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Every row of the query/u })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "CSV" })).toBeVisible();
  await expect(dialog.locator(".export-preview")).not.toBeEmpty();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByTitle("Import rows from a file…").click();
  await expect(page.getByRole("dialog", { name: "Import rows" })).toBeVisible();
});

test("says what each provisioned change will do, not only how many there are", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");
  await enterEditMode(page);

  // Read what the cell holds rather than naming it: the seed is data, not a contract.
  const cell = table.cellsWithText("Nantes").first();
  const before = ((await cell.innerText()) ?? "").trim();
  await cell.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Saint-Nazaire");
  await page.keyboard.press("Enter");

  const bar = editBar(page);
  await expect(bar.changes).toBeEnabled();
  await bar.changes.click();

  // A reader about to write to a database should be able to read the list before committing to it.
  const drawer = page.locator(".pending-edits");
  await expect(drawer).toContainText("1 change waiting to be applied");
  await expect(drawer.locator(".pending-edit-target")).toContainText("shop.address · id =");
  await expect(drawer.locator(".pending-edit-column")).toHaveText("city");
  await expect(drawer.locator(".pending-edit-original")).toHaveText(before);
  await expect(drawer.locator(".pending-edit-value")).toHaveText("Saint-Nazaire");
});

test("lights the headings a cell selection reaches, and leaves them to whole rows", async ({
  page,
}) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");
  const lit = page.locator("thead th.in-selection");

  // A rectangle of cells is bounded by columns, so the headings it reaches light up.
  await table.cellsWithText("Lille").first().click();
  await expect(lit).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(lit).toHaveCount(2);

  /*
   * The accent saying which table a column comes from is not the selection's to take. It has the
   * top edge, the selection has the bottom one, and the lift behind them is neutral — a wash in
   * the focus colour would hide an accent of the same colour.
   */
  for (const lit of await page.locator("thead th.in-selection").all()) {
    const paint = await lit.evaluate((heading) => {
      const style = getComputedStyle(heading);
      return {
        accent: `${style.borderTopWidth} ${style.borderTopColor}`,
        selection: style.borderBottomColor,
        background: style.backgroundColor,
      };
    });
    expect(paint.accent).toMatch(/^2px rgb/u);
    expect(paint.selection).not.toBe(paint.background);
    // A neutral lift has its three channels within a hair of each other; a blue wash does not.
    const [red = 0, green = 0, blue = 0] = [...paint.background.matchAll(/[\d.]+/gu)]
      .slice(0, 3)
      .map((match) => Number(match[0]));
    expect(Math.max(red, green, blue) - Math.min(red, green, blue)).toBeLessThan(
      Math.max(red, green, blue) * 0.25,
    );
  }

  // Whole rows reach every column, so lighting every heading would say nothing about them.
  await selectRows(page, 0, 1);
  await expect(lit).toHaveCount(0);
  await expect(page.locator("thead th.at-cursor")).toHaveCount(0);
  await expect(page.locator("tbody th.row-gutter.selected")).toHaveCount(2);
});

test("keeps the accent saying which table a column comes from, under the pointer", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.brand");
  await add(page, "shop.product");

  /*
   * The heading is filled edge to edge by the button that sorts it, so anything that button paints
   * — a hover above all — would cover a mark drawn inside the cell. Hovering each heading in turn
   * is the gesture that found this; asserting on a selection did not.
   */
  const headings = page.locator("thead th:not(.row-gutter)");
  const accents = new Set<string>();
  for (const heading of await headings.all()) {
    await heading.hover();
    const border = await heading.evaluate((cell) => {
      const style = getComputedStyle(cell);
      return `${style.borderTopWidth} ${style.borderTopColor}`;
    });
    expect(border).toMatch(/^2px rgb/u);
    accents.add(border);
  }
  // Two tables in the query, so two accents — the mark says something, it is not one colour.
  expect(accents.size).toBe(2);
});

test("selects and copies rows without opening the grid for writing", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  // No edit mode here: taking rows out to another application is reading, not writing, so the
  // gutter and the selection it carries belong to every grid.
  await expect(page.getByRole("toolbar", { name: "Row editing" })).toHaveCount(0);
  await expect(page.locator("tbody th.row-gutter").first()).toHaveText("1");

  await selectRows(page, 0, 1);
  await expect(page.locator("tbody tr.row-selected")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+c");

  const copied = await readClipboard(page);
  expect(copied.split("\n")).toHaveLength(2);
  expect(copied).toContain("\t");
});

test("selects rows in the gutter and takes them away together", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  // Edit mode opens with the cursor on the first cell, and says so — a grid always has one. A
  // cell is not a row, so there is still nothing to delete.
  await expect(bar.selection).toHaveText("1 row × 1 column");
  await expect(bar.remove).toBeDisabled();

  await selectRows(page, 1, 3);

  await expect(bar.selection).toHaveText("3 rows selected");
  await expect(page.locator("th.row-gutter.selected")).toHaveCount(3);
  // The band reads across every column, not only down the gutter.
  await expect(page.locator("tbody tr.row-selected")).toHaveCount(3);
  await expect(bar.remove).toBeEnabled();

  await bar.remove.click();

  // The rows stay on screen, struck through, until the changes are applied.
  await expect(page.locator("tbody tr.removed")).toHaveCount(3);
  await expect(page.locator(".row-gutter-state.removed")).toHaveCount(3);
  await expect(bar.changes).toHaveText(/3/u);
});

test("puts back rows it was going to take away", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await selectRows(page, 0, 1);
  await bar.remove.click();
  await expect(page.locator("tbody tr.removed")).toHaveCount(2);

  await bar.remove.click();

  await expect(page.locator("tbody tr.removed")).toHaveCount(0);
  await expect(bar.changes).toBeDisabled();
});

test("selects a rectangle of cells, which is not a set of rows", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await page.locator('td[data-row="0"][data-column="1"]').click();
  await expect(bar.selection).toHaveText("1 row × 1 column");

  await page.locator('td[data-row="2"][data-column="3"]').click({ modifiers: ["Shift"] });

  await expect(bar.selection).toHaveText("3 rows × 3 columns");
  await expect(page.locator("td.selected")).toHaveCount(9);
  await expect(page.locator("td.anchor")).toHaveCount(1);
  // Which table a whole row would go from is not something a rectangle answers.
  await expect(bar.remove).toBeDisabled();
});

test("extends the selection with shift and the arrow keys", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await page.locator('td[data-row="0"][data-column="1"]').click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");

  await expect(bar.selection).toHaveText("3 rows × 2 columns");

  // Without shift the selection collapses onto the cell moved to.
  await page.keyboard.press("ArrowDown");
  await expect(bar.selection).toHaveText("1 row × 1 column");
});

test("offers no row to add or delete over a join, where no one table owns the row", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);
  await expect(bar.add).toBeEnabled();

  await add(page, "shop.warehouse");

  // The gutter stays — rows can still be picked out and copied. Cells stay editable too. What
  // goes is adding and deleting: a row over a join has no one table to be added to or taken from.
  await expect(page.locator("tbody th.row-gutter").first()).toBeAttached();
  await expect(bar.add).toBeDisabled();
  await selectRows(page, 0);
  await expect(bar.remove).toBeDisabled();
});

test("adds an empty row and fills it in, without writing anything yet", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await bar.add.click();

  const added = page.locator("tbody tr.added");
  await expect(added).toHaveCount(1);
  // The new row is where the reader is looking, not at the far end of the result.
  await expect(page.locator("tbody tr").first()).toHaveClass(/added/u);
  await expect(page.locator(".row-gutter-state.added")).toHaveCount(1);
  // What the reader leaves alone is left to PostgreSQL, and the row says so.
  await expect(added.locator(".cell-value").first()).toHaveText("DEFAULT");

  await added.locator("td[data-column]").first().dblclick();
  await page.keyboard.type("Atelier Est");
  await page.keyboard.press("Enter");

  await expect(added.locator(".cell-value").first()).toHaveText("Atelier Est");
  await bar.changes.click();
  const drawer = page.locator(".pending-edits");
  await expect(drawer.locator(".pending-edit-target")).toContainText("label = Atelier Est");
  await expect(drawer.locator(".pending-edit-insertion")).toHaveText("A new row");
});

test("selects a row it had added instead of losing it", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await bar.add.click();
  const added = page.locator("tbody tr.added");
  await expect(added).toHaveCount(1);

  // Clicking the gutter of a new row selects it, the way it does for any other row.
  await added.locator("th.row-gutter").click();

  await expect(added).toHaveCount(1);
  await expect(bar.selection).toHaveText("1 row selected");
  await expect(added).toHaveClass(/row-selected/u);

  await bar.remove.click();

  await expect(page.locator("tbody tr.added")).toHaveCount(0);
  await expect(bar.changes).toBeDisabled();
});

test("puts a new row just over the row the reader is on", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  // The fifth row is where the reader is; the new one belongs over it, not at the far top.
  await selectRows(page, 4);
  const shown = page.locator("tbody tr:not(.result-spacer)");
  const wasThere = await shown.nth(4).locator("td").first().textContent();
  await editBar(page).add.click();

  await expect(shown.nth(4)).toHaveClass(/added/u);
  await expect(shown.nth(5).locator("td").first()).toHaveText(wasThere ?? "");
  // The new row takes the place the reader was on, and the selection with it: it is the row they
  // are about to fill in.
  await expect(shown.nth(4)).toHaveClass(/row-selected/u);
});

test("puts a new row at the top when the reader has not moved off it", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  await editBar(page).add.click();

  await expect(page.locator("tbody tr:not(.result-spacer)").first()).toHaveClass(/added/u);
});

test("says what taking a row away drags along, before it is taken", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  await selectRows(page, 0);
  await editBar(page).remove.click();

  // An address is pointed at from several tables, and the reader hears about it now rather than
  // when the transaction fails.
  await expect(page.locator(".data-view-statusline-text")).toContainText(
    /point at it|refuses the deletion/u,
  );
});

test("spreads a tab-separated paste across the columns from where it lands", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");
  await enterEditMode(page);

  await putOnClipboard(page, "Saint-Herblain\tFR");
  await table.cellsWithText("Lille").first().click();
  await page.keyboard.press("ControlOrMeta+v");

  const bar = editBar(page);
  await expect(bar.changes).toBeEnabled();
  await bar.changes.click();
  // Only the column that really changed is held: pasting a value a cell already has is no change.
  const drawer = page.locator(".pending-edits");
  await expect(drawer.locator(".pending-edit-column")).toHaveText("city");
  await expect(drawer.locator(".pending-edit-value")).toHaveText("Saint-Herblain");
});

test("makes a row of every pasted line that falls past the last one", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  // Three lines pasted onto the last row: the first lands on it, the other two have no row to
  // land on and become rows of their own.
  await putOnClipboard(page, "Brest\nBayonne\nColmar");
  await page.locator("tbody tr").last().locator("td[data-column]").first().click();
  await page.keyboard.press("ControlOrMeta+v");

  await expect(page.locator("tbody tr.added")).toHaveCount(2);
  await expect(editBar(page).changes).toHaveText(/3/u);
});

test("copies the selection to the clipboard the way a spreadsheet would", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  await selectRows(page, 0, 1);
  await page.keyboard.press("ControlOrMeta+c");

  // Tab between columns, newline between rows, in the order they are shown — read back off the
  // clipboard the reader would paste from, not off the event.
  const copied = await readClipboard(page);
  expect(copied.split("\n")).toHaveLength(2);
  expect(copied).toContain("\t");
});

test("carries a copied row into a new one, by keyboard alone", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");
  await enterEditMode(page);
  // Whichever row the fixture puts there: what is copied is read off the screen, not assumed.
  const copied = await page
    .locator("tbody tr:not(.result-spacer)")
    .nth(3)
    .locator("td[data-column]")
    .allTextContents();

  // The whole journey a reader makes, with nothing in between: pick a row, copy it, press the
  // button that makes an empty one, paste into it. Pressing the button must not carry the
  // keystrokes off with it — the paste still belongs to the grid.
  await selectRows(page, 3);
  await page.keyboard.press("ControlOrMeta+c");

  await editBar(page).add.click();
  // The row has to be there to be pasted into. A reader waits to see it appear; a test that does
  // not pastes onto the loaded row that still holds the place, and edits it instead.
  await expect(page.locator("tbody tr.added")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+v");

  // Every value lands in the column it was copied from, none shifted along — and a column the
  // source had nothing in is left to the database rather than set to an empty string.
  const added = page.locator("tbody tr.added").first();
  await expect(added).toContainText(copied[0] ?? "");
  const wanted = copied.map((text) => (text === "NULL" ? "DEFAULT" : text));
  expect(await added.locator("td[data-column]").allTextContents()).toEqual(wanted);
  // The row it was copied from is still there, one place down, beside its copy.
  await expect(table.cellsWithText(copied[4] ?? "")).toHaveCount(2);
});

test("writes the row it was given, and takes it away again", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);
  /*
   * A row nothing else in the table looks like. What is written and what is taken back are then
   * beyond doubt — a row picked out by a value the fixture already holds can be confused with the
   * one it was copied from, and a run that stopped halfway would leave the table quietly changed.
   */
  const mark = "Zzz round trip";
  await putOnClipboard(page, `${mark}\t1 rue de l'Essai\t\t99999\tZzzville\tFR`);

  // The whole journey, ending where it is supposed to end: in the database.
  await bar.add.click();
  await expect(page.locator("tbody tr.added")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+v");
  await bar.apply.click();

  // What is asserted is what lasts: the row is in the result and nothing is held any more. The
  // notice saying so dismisses itself, and a test that waits for it is waiting on a stopwatch.
  await expect(table.cellsWithText(mark)).toHaveCount(1);
  await expect(page.locator("tbody tr.added")).toHaveCount(0);
  await expect(bar.changes).toBeDisabled();

  // And back out again, so the database is left as it was found.
  await page.locator("tbody tr").filter({ hasText: mark }).locator("th").click();
  await bar.remove.click();
  await bar.apply.click();

  await expect(table.cellsWithText(mark)).toHaveCount(0);
});

test("shows what an export will give, before it is written", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  await selectRows(page, 2, 4);
  await openExport(page);

  // The reader's selection is the scope offered first, and it says how much it covers.
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await expect(dialog.getByRole("radio", { name: /The selection/u })).toBeChecked();
  await expect(dialog.getByText(/The selection/u).locator("..")).toContainText("3 rows");

  // And the preview is the file: a header line, then the three rows picked out.
  const preview = dialog.locator(".export-preview");
  await expect(preview).toContainText("label,line1");
  expect((await preview.textContent())?.trim().split("\n")).toHaveLength(4);

  /*
   * And the panel does not move as the reader tries the shapes. It hangs from the top and keeps
   * its room, so the button they are reaching for is where it was when they decided to press it.
   */
  const where = async () =>
    dialog.evaluate((panel) => JSON.stringify(panel.getBoundingClientRect()));
  const before = await where();

  // A different shape, the same rows, read back before anything is written.
  await dialog.getByRole("radio", { name: "Markdown" }).check();
  expect(await where()).toBe(before);
  await expect(preview).toContainText("|---");
  await dialog.getByRole("radio", { name: "JSON" }).check();
  await expect(preview).toContainText('"label"');
  expect(await where()).toBe(before);
});

test("offers no INSERT statements where no one table owns the rows", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await openExport(page);
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await expect(dialog.getByRole("radio", { name: "SQL" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Close" }).click();
  await add(page, "shop.warehouse");
  await openExport(page);

  // Over a join there is no single table to insert into, and the dialog says so rather than
  // offering a shape it would refuse afterwards.
  const joined = page.getByRole("dialog", { name: "Export rows" });
  await expect(joined.getByRole("radio", { name: "SQL" })).toBeDisabled();
  await expect(joined.getByText(/INSERT statements need one table/u)).toBeVisible();
});

test("writes the rows the reader picked out, in the shape they chose", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  await selectRows(page, 0, 1);
  await openExport(page);
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await dialog.getByRole("radio", { name: "TSV" }).check();
  const written = (await dialog.locator(".export-preview").textContent()) ?? "";
  await dialog.getByRole("button", { name: "Export" }).click();

  await expect(page.locator(".data-view-statusline-text")).toContainText(/Exported 2 rows/u);
  // The file holds what the preview showed: it is written by the same module that showed it.
  const file = join(EXPORTS, "address.tsv");
  await expect(async () => expect(existsSync(file)).toBe(true)).toPass();
  expect(readFileSync(file, "utf8").trim()).toBe(written.trim());
});

test("says a refused write in a band across the top, not in a corner", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  // An empty row cannot go in: the table will not have a row without a line1.
  await bar.add.click();
  await bar.apply.click();

  const band = page.getByRole("alert");
  await expect(band).toContainText(/not applied/u);
  // The changes are still held, so the reader can put right what was refused.
  await expect(bar.changes).toHaveText(/1/u);
  // And it is said once: the status line does not repeat what the band already carries.
  await expect(page.locator(".data-view-statusline-text")).not.toContainText(/not applied/u);

  await band.getByRole("button", { name: "Dismiss" }).click();
  await expect(band).toHaveCount(0);

  // Asking again says it again, in the same words: a dismissal was about the last attempt.
  await bar.apply.click();
  await expect(page.getByRole("alert")).toContainText(/not applied/u);
});

test("brings back the columns a new row cannot go without", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.inventory_movement");
  await enterEditMode(page);

  // Relationship columns start hidden, and one of them is exactly what an insertion needs.
  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toHaveCount(0);

  await editBar(page).add.click();

  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toHaveCount(1);
  // The key PostgreSQL generates for itself stays out of the way, and so does a defaulted column.
  await expect(page.getByRole("columnheader", { name: /^id/u })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /occurred_at/u })).toHaveCount(1);
});

test("keeps identity and relationship columns out of the way until they are needed", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.inventory_movement");
  await enterEditMode(page);

  // Relationship columns are hidden because a reader has no use for them, not because they cannot
  // be edited — and over a single table they can be, which is what an insertion needs.
  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /performed_by/u })).toHaveCount(0);

  await editBar(page).add.click();

  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toHaveCount(1);
  // Nullable, so the row can go without it: it stays out of the way.
  await expect(page.getByRole("columnheader", { name: /performed_by/u })).toHaveCount(0);

  const cell = page.locator("tbody td[data-added-row]").first();
  await cell.dblclick();
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");

  await expect(cell.locator(".cell-value")).toHaveText("1");
});

test("offers to import only where rows can go", async ({ page }) => {
  await openEmpty(page);

  // Nothing to import into, and the control says so rather than opening on nothing. The sentence
  // completes one the engine owns, so adding, removing and importing all give the same reason.
  await expect(
    page.getByTitle("Rows can only be imported once the query has a table to write them to."),
  ).toBeDisabled();
  await expect(page.getByTitle("Export rows to a file…")).toBeDisabled();

  await add(page, "shop.address");

  await expect(page.getByTitle("Import rows from a file…")).toBeEnabled();
  await expect(page.getByTitle("Export rows to a file…")).toBeEnabled();

  await add(page, "shop.warehouse");

  // Rows come in one table at a time, exactly as they are added one at a time.
  await expect(
    page.getByTitle("Rows can only be imported to one table, and this query joins several."),
  ).toBeDisabled();
  await expect(page.getByTitle("Export rows to a file…")).toBeEnabled();
});
