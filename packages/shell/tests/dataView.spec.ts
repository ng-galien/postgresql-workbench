import { expect, type Page, test } from "@playwright/test";
import { ResultTable } from "../../views/testing/ResultTable.js";

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
  await expect(rows.summary("4 rows")).toBeVisible();
  expect(await runningSql(page)).toMatch(/FROM\s+shop\.product AS product/u);
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
  await expect(rows.summary("3 rows")).toBeVisible();
});

test("sorts on a column, and says so in the SQL", async ({ page }) => {
  await openEmpty(page);
  const rows = await add(page, "shop.product");

  await page.getByTitle(/^Sort by price/u).click();

  await expect.poll(async () => runningSql(page)).toMatch(/ORDER BY\s+product\.price ASC/u);
  // Cheapest first: the rows really came back sorted, not just the SQL.
  await expect(rows.cell(0, 2)).toHaveText("6.40");
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

  // A movement table is the one that really grows: the first page is a page, not the whole thing.
  await expect(rows.summary("Rows 1–200 · more available")).toBeVisible();

  await rows.next();
  await expect(rows.summary("Rows 201–400 · more available")).toBeVisible();
  await rows.previous();
  await expect(rows.summary("Rows 1–200 · more available")).toBeVisible();

  await rows.loadAll();
  // The whole table, however many rows the seed holds and whatever a reader has since deleted:
  // what matters is that nothing is left to fetch.
  await expect(page.getByText(/^\d[\d,]* rows$/u)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/more available/u)).toBeHidden();
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

  // Composing, walking the rows and choosing the columns is the work; reading the SQL and
  // exporting happen once in a session. The bar is ordered by how often a control is used.
  const often = page.locator(".toolbar-side-often");
  const seldom = page.locator(".toolbar-side-seldom");
  await expect(often.getByTitle("Refresh")).toBeVisible();
  await expect(often.getByTitle(/^Next page$/u)).toBeVisible();
  await expect(often.getByTitle(/^(Show or hide columns|Columns \()/u)).toBeVisible();
  await expect(seldom.getByTitle(/the SQL$/u)).toBeVisible();
  await expect(seldom.getByTitle("More actions")).toBeVisible();
});

test("moves rows in and out through dialogs of their own", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.sales_order");

  // Six near-identical export lines used to bury everything else in the actions menu.
  await page.getByTitle("More actions").click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(3);
  await page.keyboard.press("Escape");

  await page.getByTitle("Export rows to a file…").click();
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await expect(dialog.getByText("Loaded rows")).toBeVisible();
  await expect(dialog.getByText("All rows")).toBeVisible();
  await expect(dialog.getByRole("menuitem", { name: "CSV…" })).toHaveCount(2);

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

test("selects rows in the gutter and takes them away together", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  // Nothing is selected, so there is nothing to delete.
  await expect(bar.selection).toHaveText("Nothing selected");
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

test("offers no gutter over a join, where no one table owns the row", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  await expect(page.locator("tbody th.row-gutter").first()).toBeAttached();

  await add(page, "shop.warehouse");

  // Cells stay editable over a join; whole rows have no single table to go from.
  await expect(page.locator("tbody th.row-gutter")).toHaveCount(0);
});

test("adds an empty row and fills it in, without writing anything yet", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  await bar.add.click();

  const added = page.locator("tbody.added-rows tr.added");
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
  const added = page.locator("tbody.added-rows tr.added");
  await expect(added).toHaveCount(1);

  // Clicking the gutter of a new row selects it, the way it does for any other row.
  await added.locator("th.row-gutter").click();

  await expect(added).toHaveCount(1);
  await expect(bar.selection).toHaveText("1 row selected");
  await expect(added).toHaveClass(/row-selected/u);

  await bar.remove.click();

  await expect(page.locator("tbody.added-rows tr.added")).toHaveCount(0);
  await expect(bar.changes).toBeDisabled();
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

  await expect(page.locator("tbody.added-rows tr.added")).toHaveCount(2);
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

  // The whole journey a reader makes: pick a row, copy it, make an empty row, paste into it.
  await selectRows(page, 0);
  await page.keyboard.press("ControlOrMeta+c");
  const copied = await readClipboard(page);

  await editBar(page).add.click();
  await page.locator("tbody.added-rows tr.added th.row-gutter").click();
  await page.keyboard.press("ControlOrMeta+v");

  const added = page.locator("tbody.added-rows tr.added").first();
  await expect(added).toContainText(copied.split("\t")[0] ?? "");
  await expect(table.cellsWithText("Lille")).toHaveCount(2);
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

  const cell = page.locator("tbody.added-rows td[data-added-row]").first();
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
