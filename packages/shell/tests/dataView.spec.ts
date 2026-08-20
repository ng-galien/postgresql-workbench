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
  // Nothing is reachable from nothing, so every table is offered as a starting point.
  await expect(menu.getByText("Other tables and views")).toBeVisible();
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
  await expect(page.getByText("4008 rows")).toBeVisible({ timeout: 20_000 });
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

  // Moving a table moves its columns; the FROM clause keeps its own order, and the two must not
  // drift apart to the point where removing one relation takes another's columns.
  const [inventory, product] = await page.getByTitle(/its columns carry the same accent/u).all();
  if (!inventory || !product) throw new Error("expected two table badges");
  await inventory.dragTo(product);

  await page.getByRole("button", { name: "Remove shop.product" }).click();

  const sql = await runningSql(page);
  expect(sql).not.toContain("shop.product");
  expect(sql).not.toContain("product.name");
  expect(sql).toContain("inventory.quantity");
  expect(sql).toMatch(/FROM\s+shop\.inventory AS inventory/u);
});
