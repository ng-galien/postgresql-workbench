import { expect, type Page, test } from "@playwright/test";
import { ResultTable } from "../../views/testing/ResultTable.js";

/**
 * The complete Data View journey, against the real engines. Every assertion here is about what the
 * product does — the SQL it builds, the joins it plans, the rows PostgreSQL answers with — and none
 * of it needs VS Code.
 */

/**
 * The shell is one running application, so a scenario puts its query back before it starts —
 * the same reason the VS Code lanes reset the workbench between journeys.
 */
async function openDataView(page: Page): Promise<ResultTable> {
  await page.request.post("/reset");
  await page.goto("/");
  const rows = new ResultTable(page);
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(rows.cellsWithText("Saumon fumé")).toHaveCount(1);
  return rows;
}

/** The SQL the view says it is running, read line by line out of its panel. */
async function runningSql(page: Page): Promise<string> {
  const panel = page.getByRole("region", { name: "Query SQL" });
  if (!(await panel.isVisible())) await page.getByTitle(/Show the SQL/u).click();
  return (await panel.locator(".postgres-source-line-code").allInnerTexts()).join("\n");
}

test("opens a relation and shows its rows", async ({ page }) => {
  const rows = await openDataView(page);

  await expect(rows.summary("4 rows")).toBeVisible();
  await expect(rows.cellsWithText("Poivre fumé")).toHaveCount(1);
  expect(await runningSql(page)).toContain("FROM\n  shop.product AS product");
});

test("sorts on a column, and says so in the SQL", async ({ page }) => {
  await openDataView(page);

  await page.getByTitle(/^Sort by price/u).click();

  await expect.poll(async () => runningSql(page)).toContain("ORDER BY");
  expect(await runningSql(page)).toMatch(/ORDER BY\s+product\.price ASC/u);
  // Cheapest first: the rows really came back sorted, not just the SQL.
  const rows = new ResultTable(page);
  await expect(rows.cell(0, 2)).toHaveText("6.40");
});

test("filters on a WHERE the reader types", async ({ page }) => {
  await openDataView(page);

  const filter = page.getByRole("combobox", { name: /where/iu });
  await filter.fill("product.stock = 0");
  await filter.press("Enter");

  const rows = new ResultTable(page);
  await expect(rows.cellsWithText("Truite fumée")).toHaveCount(1);
  await expect(rows.cellsWithText("Saumon fumé")).toHaveCount(0);
  expect(await runningSql(page)).toContain("product.stock = 0");
});

test("joins a related table the engine planned from a foreign key", async ({ page }) => {
  await openDataView(page);

  await page.getByTitle(/Add a column or a related table/u).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: /shop\.brand/u }).click();

  // The badge strip names both relations, and the SQL carries the JOIN the planner chose.
  await expect(page.getByTitle(/shop\.brand — its columns carry the same accent/u)).toBeVisible();
  expect(await runningSql(page)).toMatch(/JOIN\s+shop\.brand/u);
});

test("removes a table and everything that referenced it", async ({ page }) => {
  await openDataView(page);
  await page.getByTitle(/Add a column or a related table/u).click();
  await page.getByRole("menuitem", { name: /shop\.brand/u }).click();
  await expect(page.getByTitle(/shop\.brand — its columns/u)).toBeVisible();

  await page.getByRole("button", { name: "Remove shop.brand" }).click();

  await expect(page.getByTitle(/shop\.brand — its columns/u)).toBeHidden();
  expect(await runningSql(page)).not.toContain("shop.brand");
});

test("reads the SQL in the view, and closes it again", async ({ page }) => {
  await openDataView(page);

  await page.getByTitle(/Show the SQL/u).click();
  const panel = page.getByRole("region", { name: "Query SQL" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("SELECT")).toBeVisible();

  await panel.getByTitle(/Hide the SQL/u).click();
  await expect(panel).toBeHidden();
});

test("hides a column without dropping it from the query", async ({ page }) => {
  await openDataView(page);

  await page.getByTitle(/Show or hide columns/u).click();
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
  await openDataView(page);

  const filter = page.getByRole("combobox", { name: /where/iu });
  await filter.fill("product.");

  const proposals = page.getByRole("listbox", { name: /completion/iu });
  await expect(proposals).toBeVisible();
  // The type comes from the catalog through the server; the view's own columns carry no type.
  await expect(proposals.getByText("numeric(8,2)")).toBeVisible();
  await expect(proposals.getByText("brand_id")).toBeVisible();
});
