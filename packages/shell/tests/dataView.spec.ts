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
  await expect(rows.rowRange).toHaveText("4");
  expect(await runningSql(page)).toMatch(/FROM\s+shop\.product AS product/u);
});

test("composes a table by keyboard alone: type, walk down, press Enter", async ({ page }) => {
  await openEmpty(page);
  await page.getByTitle(/Add (the first table|a column or a related table)/u).click();

  // The filter has the focus when it opens, so a reader types straight into it — once it has it.
  await expect(page.getByPlaceholder("Filter columns and related tables…")).toBeFocused();
  await page.keyboard.type("order");
  const proposals = page.getByRole("menu").getByRole("menuitem");
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
  const chosen = (await proposals.nth(2).locator(".menu-label").textContent()) ?? "";

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

test("tells apart two paths that traverse the same relations", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  await page.getByTitle(/Add (the first table|a column or a related table)/u).click();
  await page.getByTitle(/^JOIN shop\.app_user(\s|$)/u).click();

  /*
   * A sales order holds a billing address and a shipping address, so two of the paths offered
   * traverse the same relations in the same order. Named by their relations alone they would be
   * the same line twice, and a reader offered both could not choose between them.
   */
  const paths = await page.getByRole("menu").last().getByRole("menuitem").allInnerTexts();
  const throughOrder = paths.filter((path) => path.includes("via shop.sales_order"));
  expect(throughOrder).toHaveLength(2);
  expect(new Set(throughOrder).size).toBe(2);
  expect(throughOrder.join("\n")).toContain("sales_order.billing_address_id");
  expect(throughOrder.join("\n")).toContain("sales_order.shipping_address_id");
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
  await expect(rows.rowRange).toHaveText("3");
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

test("colours the SQL by what the language server makes of its names", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.brand");
  await add(page, "shop.product");

  await page.getByTitle(/Show the SQL/u).click();
  await expect(page.getByRole("region", { name: "Query SQL" })).toBeVisible();

  /*
   * The grammar cannot tell a table from the alias standing for it from a column of it: they are
   * all identifiers to it. The server has the Workbench Index and can, so the names it reports are
   * painted over what the grammar coloured — and a reader who cannot tell them apart by colour has
   * gained nothing, so they are also kept apart.
   */
  const painted = page.locator(".postgres-source-token[class*=postgres-token-]");
  await expect(painted.first()).toBeVisible();
  const colours = await painted.evaluateAll((spans) => {
    const of = (kind: string) => {
      const span = spans.find((candidate) =>
        candidate.classList.contains(`postgres-token-${kind}`),
      );
      return span ? getComputedStyle(span).color : undefined;
    };
    return { table: of("sqlTable"), alias: of("sqlAlias"), column: of("sqlColumn") };
  });

  expect(colours.table).toBeDefined();
  expect(new Set(Object.values(colours)).size).toBe(3);

  /*
   * And the panel and the field are coloured at the same time. They ask the same question of the
   * same host, so each has to be able to tell its own answer from the other's: counted apart, both
   * asked a request 1 and each took the other's tokens.
   */
  const inPanel = page.locator(".data-view-sql [class*=postgres-token-]");
  const namedInPanel = await inPanel.count();
  expect(namedInPanel).toBeGreaterThan(4);

  await page.getByRole("combobox", { name: /where/iu }).fill("brand.name LIKE 'F%'");
  await expect(page.locator(".filter-highlight .postgres-token-sqlAlias").first()).toBeVisible();
  // The panel still holds the query's names, not the two the condition answered with.
  await expect(inPanel).toHaveCount(namedInPanel);
});

test("hands over the statement the rows came from", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  const shown = await runningSql(page);

  const panel = page.getByRole("region", { name: "Query SQL" });
  await panel.getByTitle("Copy this SQL").click();

  // What is on the clipboard is the statement itself, ready to paste into an editor — not the
  // line numbers beside it, and not a description of it.
  const copied = await readClipboard(page);
  expect(copied).toBe(shown);
  expect(copied).toMatch(/^SELECT\n/u);
  expect(copied).toContain("shop.product");

  // And the control says it happened, because a copy leaves the page looking exactly as it was.
  await expect(panel.getByTitle("SQL copied")).toBeVisible();
});

test("opens an address with the chord, and selects the cell without it", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.brand");

  const link = page.locator(".cell-link").first();
  await expect(link).toHaveAttribute("title", /(Cmd|Ctrl)\+click to open https:/u);

  /*
   * A plain click is a click in the grid: it selects the cell it lands on and goes nowhere. The
   * page would be gone if it did — which is what the assertion after it proves.
   */
  await link.click();
  await expect(page).toHaveURL(/localhost/u);
  await expect(table.cellsWithText("https://example.test/fumoir").first()).toHaveClass(/selected/u);

  // It is marked text, not a false native link: the keys reach Open through the cell menu.
  await expect(link).not.toHaveAttribute("href");
  await expect(
    table.cellsWithText("https://example.test/fumoir").first().getByRole("button"),
  ).toHaveCount(0);

  /*
   * And the chord goes there. Asserting only what is refused is how a link that never opened at
   * all went unnoticed — so this asserts the address the view handed its host.
   */
  await link.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(page.locator("body")).toHaveAttribute(
    "data-followed-link",
    "https://example.test/fumoir",
  );
});

test("inspects a timestamp as PostgreSQL text, not as JSON", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.address");

  await table.cell(0, 7).click();
  const inspectorToggle = page.getByTitle("Show the value under the cursor, whole");
  await inspectorToggle.click();

  const inspector = page.getByRole("complementary", { name: "Value of created_at" });
  const activeInspectorToggle = page.getByTitle("Stop showing the value under the cursor");
  await expect(activeInspectorToggle).toHaveAttribute("aria-expanded", "true");
  await expect(activeInspectorToggle).toHaveAttribute(
    "aria-controls",
    await inspector.getAttribute("id"),
  );
  await expect(inspector.locator(".cell-inspector-text")).toContainText(/^\d{4}-\d{2}-\d{2}[ T]/u);
  await expect(inspector.locator(".cell-inspector-json")).toHaveCount(0);
  await expect(inspector).not.toContainText("Not valid JSON");
  const scrollerHeight = await page
    .locator(".result-scroller")
    .evaluate((element) => element.clientHeight);
  const scrollbarHeight = await page
    .locator(".result-scrollbar")
    .evaluate((element) => element.clientHeight);
  expect(Math.abs(scrollbarHeight - scrollerHeight)).toBeLessThanOrEqual(1);

  const before = await inspector.boundingBox();
  const handle = inspector.getByTitle("Drag to move");
  const handleBounds = await handle.boundingBox();
  if (!before || !handleBounds) throw new Error("The value inspector must expose its move handle");
  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBounds.x - 100, handleBounds.y + handleBounds.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  const moved = await inspector.boundingBox();
  expect(moved?.x).toBeLessThan(before.x - 70);

  await handle.focus();
  await handle.press("ArrowLeft");
  expect((await inspector.boundingBox())?.x).toBeLessThan((moved?.x ?? 0) - 10);

  const resize = inspector.getByRole("button", { name: "Resize the value panel (arrow keys)" });
  const beforeKeyboardResize = await inspector.boundingBox();
  await resize.focus();
  await resize.press("ArrowRight");
  await resize.press("ArrowDown");
  const keyboardResized = await inspector.boundingBox();
  expect(keyboardResized?.width).toBeGreaterThan((beforeKeyboardResize?.width ?? 0) + 10);
  expect(keyboardResized?.height).toBeGreaterThan((beforeKeyboardResize?.height ?? 0) + 10);

  const resizeBounds = await resize.boundingBox();
  if (!resizeBounds) throw new Error("The value inspector must expose its resize handle");
  await page.mouse.move(resizeBounds.x + 3, resizeBounds.y + 3);
  await page.mouse.down();
  await page.mouse.move(-200, resizeBounds.y - 100, { steps: 6 });
  await page.mouse.up();
  const frame = inspector.locator("xpath=..");
  await expect
    .poll(async () => {
      const panelBounds = await inspector.boundingBox();
      const frameBounds = await frame.boundingBox();
      if (!panelBounds || !frameBounds) return false;
      return (
        panelBounds.x >= frameBounds.x - 1 &&
        panelBounds.y >= frameBounds.y - 1 &&
        panelBounds.x + panelBounds.width <= frameBounds.x + frameBounds.width + 1 &&
        panelBounds.y + panelBounds.height <= frameBounds.y + frameBounds.height + 1
      );
    })
    .toBe(true);
  await page.setViewportSize({ width: 700, height: 720 });
  await expect
    .poll(async () => {
      const panelBounds = await inspector.boundingBox();
      const frameBounds = await frame.boundingBox();
      if (!panelBounds || !frameBounds) return false;
      return panelBounds.x + panelBounds.width <= frameBounds.x + frameBounds.width + 1;
    })
    .toBe(true);
  await inspector.getByRole("button", { name: "Close the value panel" }).click();
  await expect(inspector).toBeHidden();
  await expect(inspectorToggle).toBeFocused();
  await expect(inspectorToggle).toHaveAttribute("aria-expanded", "false");
});

test("opens the menu of the cell the box is on, from the keys alone", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.brand");

  await table.cellsWithText("https://example.test/fumoir").first().click();
  await page.keyboard.press("Shift+F10");

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Following the address is what a cell holding one is for, so it is the first thing offered.
  await expect(menu.getByRole("menuitem").first()).toHaveText("Open");
  await expect(menu.getByRole("menuitem", { name: "Copy" })).toBeVisible();

  // It opens under the cell it acts on, not in a corner of the page.
  const cell = await table.cellsWithText("https://example.test/fumoir").first().boundingBox();
  const box = await menu.boundingBox();
  expect(box?.y).toBeGreaterThan(cell?.y ?? 0);

  /* And it follows it, which is the whole point of offering it to the keyboard. */
  await menu.getByRole("menuitem", { name: "Open" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-followed-link",
    "https://example.test/fumoir",
  );
  await expect(menu).toBeHidden();
});

test("shows the way across a result wider than the pane", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  /*
   * Rows are loaded as a reader walks them, so the bar beside them is drawn by hand — but every
   * column is already there, and the browser's own bar is what says a result runs past the edge.
   * `scrollbar-width: none` hides both axes. The grid therefore hides native vertical interaction
   * with `overflow-y`, while preserving the browser's horizontal bar. The result's own vertical
   * control is the only one a reader should see beside the rows.
   */
  const across = await page.locator(".result-scroller").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflows: element.scrollWidth > element.clientWidth,
      hiding: style.scrollbarWidth,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    };
  });

  expect(across.overflows).toBe(true);
  expect(across.overflowX).toBe("auto");
  expect(across.hiding).not.toBe("none");
  expect(across.overflowY).toBe("hidden");
  // And the one down the rows is still the hand-drawn one.
  await expect(page.locator(".result-scrollbar")).toBeVisible();
  const scroller = page.locator(".result-scroller");
  const diagonalLeft = await scroller.evaluate((element) => {
    element.scrollLeft = 0;
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 80, deltaY: 20 }),
    );
    return element.scrollLeft;
  });
  expect(diagonalLeft).toBeGreaterThan(0);
  const shiftedLeft = await scroller.evaluate((element) => {
    element.scrollLeft = 0;
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80, shiftKey: true }),
    );
    return element.scrollLeft;
  });
  expect(shiftedLeft).toBeGreaterThan(0);
});

test("gives a column the width the reader drags it to, and takes it back", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  const headings = page.locator("thead th:not(.row-gutter)");
  const heading = headings.filter({ hasText: "description" }).first();
  const handle = heading.locator(".column-resize");
  const widthOf = async () => (await heading.boundingBox())?.width ?? 0;
  const fitted = await widthOf();
  const wasAt = await headings.evaluateAll((cells) =>
    cells.findIndex((cell) => cell.textContent?.includes("description")),
  );

  // Held by its edge, a column follows the pointer. The heading is draggable — that is how a
  // column is moved — so this gesture has to be the one that wins on the edge.
  const grip = await handle.boundingBox();
  if (!grip) throw new Error("no resize handle");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(widthOf).toBeGreaterThan(fitted + 60);
  // The order of the columns is what it was: resizing one is not moving it.
  await expect(headings.nth(wasAt)).toContainText("description");

  // Double-clicking the edge gives the column back the width its content asks for.
  await handle.dblclick();
  await expect.poll(widthOf).toBe(fitted);
});

test("widens and narrows a column from the keyboard alone", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  const handle = page.locator("thead th", { hasText: "sku" }).first().locator(".column-resize");
  await handle.focus();
  const started = Number(await handle.getAttribute("aria-valuenow"));

  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(started + 1));
  // Held down, the shift key moves it in bigger steps, so a wide column is not forty presses away.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(started + 9));
  await page.keyboard.press("Escape");
  await expect(handle).toHaveAttribute("aria-valuenow", String(started));
});

test("finds what the reader is looking for among the rows, and walks the matches", async ({
  page,
}) => {
  await openEmpty(page);
  const table = await add(page, "shop.product");

  // Ctrl+F reaches the grid the same way every other keystroke does, through its clipboard proxy.
  await table.cell(0, 1).click();
  await page.keyboard.press("Control+f");
  const finder = page.getByRole("search");
  await expect(finder).toBeVisible();

  await page.keyboard.type("fum");
  const count = finder.locator(".grid-finder-count");
  // Three products are smoked, and one of them says so twice — in its name and its description.
  await expect(count).toHaveText(/of \d+$/u);
  const total = Number((await count.innerText()).split(" of ")[1]);
  expect(total).toBeGreaterThan(1);

  // The cursor lands on a match as the reader types, so they see where they are.
  await expect(count).toHaveText(`1 of ${total}`);
  await expect(page.locator("td.match.anchor")).toHaveCount(1);
  await expect(page.locator("td.match")).toHaveCount(total);

  // Enter walks forward, Shift+Enter back, and both wrap round rather than stopping.
  await page.keyboard.press("Enter");
  await expect(count).toHaveText(`2 of ${total}`);
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText(`1 of ${total}`);
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText(`${total} of ${total}`);

  // Something no row holds says so, rather than leaving the reader to wonder.
  await page.keyboard.press("Control+a");
  await page.keyboard.type("zzzz");
  await expect(count).toHaveText("No match");
  await expect(page.locator("td.match")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(finder).toBeHidden();
  await expect(page.locator("td.match")).toHaveCount(0);
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

test("keeps the caret on the line the filter was typed on", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  const where = page.getByRole("combobox", { name: /where/iu });
  await where.click();
  await where.fill("city = 'Lyon'");
  await page.keyboard.press("Enter");

  // The rows are fetched with the caret still here: a reader who ran a filter is still writing it.
  await expect(where).toBeFocused();
  await expect(page.locator("tbody tr:not(.result-spacer)")).toHaveCount(1);
  await expect(where).toBeFocused();
});

test("filters on what a cell holds, and says so in the WHERE", async ({ page }) => {
  await openEmpty(page);
  const table = await add(page, "shop.brand");

  // shop.brand projects id, name, website, country_code…: the country is the fourth column.
  await table.cellsWithText("FR").first().click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Verbs, and only the ones this cell can be acted on with.
  await expect(menu.getByRole("menuitem")).toHaveText(["Filter", "Exclude", "Inspect", "Copy"]);

  await menu.getByRole("menuitem", { name: "Filter" }).click();

  /*
   * The condition is written where the reader can read it, correct it and undo it — the relation
   * named as the query names it, the value as a literal — not applied behind them.
   */
  await expect(page.getByRole("combobox", { name: /where/iu })).toHaveValue(
    "brand.country_code = 'FR'",
  );
  await expect(page.locator("tbody tr:not(.result-spacer)")).toHaveCount(3);
});

test("colours the condition being typed, the way the SQL is coloured", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.brand");

  const where = page.getByRole("combobox", { name: /where/iu });
  await where.fill("brand.name LIKE 'F%'");

  /*
   * A condition is SQL, and on its own it is not a statement: `brand` is an alias only the query
   * around it explains. The host asks about it as part of that query and carries the answer back,
   * so the field shows what the panel shows — the grammar's colours, and the names resolved.
   */
  const painted = page.locator(".filter-highlight .postgres-source-token[class*=postgres-token-]");
  await expect(painted.first()).toBeVisible();
  await expect(painted.filter({ hasText: "brand" }).first()).toHaveClass(
    /postgres-token-sqlAlias/u,
  );
  await expect(painted.filter({ hasText: "name" }).first()).toHaveClass(
    /postgres-token-sqlColumn/u,
  );

  // What is painted is exactly what is typed: the two are drawn on top of each other.
  const layer = page.locator(".filter-highlight");
  expect(await layer.innerText()).toBe(await where.inputValue());
});

test("proposes the language a condition is written in, not only the schema", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  const where = page.getByRole("combobox", { name: /where/iu });
  await where.fill("an");

  /*
   * No column of shop.address starts with those letters, and a reader writing a condition needs
   * the words holding it together as much as the names it puts between them.
   */
  const proposals = page.getByRole("listbox", { name: /completion/iu });
  await expect(proposals).toBeVisible();
  await expect(proposals.getByText("AND", { exact: true })).toBeVisible();

  // The schema still comes first: the language is offered after everything the index knows.
  await where.fill("l");
  await expect(proposals.locator(".filter-completion").first()).toContainText("label");
});

test("puts a proposal in place of what is being typed, phrase and all", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  const where = page.getByRole("combobox", { name: /where/iu });
  const proposals = page.getByRole("listbox", { name: /completion/iu });
  const accept = async (typed: string, proposal: string) => {
    await where.fill(typed);
    await expect(proposals).toBeVisible();
    await proposals.locator(".filter-completion").filter({ hasText: proposal }).first().click();
    return where.inputValue();
  };

  // What was typed goes: a proposal continues the reader's word, it does not follow it.
  expect(await accept("l", "LIKE")).toBe("LIKE");
  expect(await accept("ci", "city")).toBe("address.city");

  /*
   * And a phrase takes every word it continues, not only the last one. The server says the span
   * for each proposal; a client left to guess would replace the `n` alone and write `id is IS NOT
   * NULL`.
   */
  expect(await accept("id is n", "IS NOT NULL")).toBe("id IS NOT NULL");
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
  const navigation = page.locator(".result-navigation");
  const nextArrow = page.locator('.data-view-rows-line button[title="Next page"]');
  const where = () => nextArrow.evaluate((b) => Math.round(b.getBoundingClientRect().x));
  const navigationWidth = () =>
    navigation.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  await expect(summary).toHaveText("1–200");
  const arrowAt = await where();
  const widthBeforePaging = await navigationWidth();

  await rows.next();
  await expect(page.getByTitle("Cancel loading")).toBeVisible();
  expect(await where()).toBe(arrowAt);
  expect(await navigationWidth()).toBe(widthBeforePaging);
  await expect(summary).toHaveText("201–400");
  expect(await where()).toBe(arrowAt);
  expect(await navigationWidth()).toBe(widthBeforePaging);
  await rows.previous();
  await expect(nextArrow).toBeDisabled();
  await expect(page.getByTitle("Cancel loading")).toHaveCount(0);
  await expect(summary).toHaveText("1–200");
  expect(await where()).toBe(arrowAt);
  expect(await navigationWidth()).toBe(widthBeforePaging);

  await rows.loadAll();
  await expect(page.getByTitle("Cancel loading")).toBeVisible();
  expect(await navigationWidth()).toBe(widthBeforePaging);
  // The whole table, however many rows the seed holds and whatever a reader has since deleted:
  // what matters is that nothing is left to fetch.
  await expect(summary).toHaveText(/^\d+$/u, { timeout: 20_000 });
  expect(await navigationWidth()).toBe(widthBeforePaging);

  const largeRange = await summary.evaluate((element) => {
    element.textContent = "99999901–100000000";
    const next = element.nextElementSibling;
    const bounds = element.getBoundingClientRect();
    const nextBounds = next?.getBoundingClientRect();
    return {
      clipped: element.scrollWidth > element.clientWidth,
      clearsNext: nextBounds !== undefined && bounds.right <= nextBounds.left,
    };
  });
  expect(largeRange).toEqual({ clipped: true, clearsNext: true });
});

test("cancels a delayed page read without reporting a second session error", async ({ page }) => {
  await openEmpty(page);
  const rows = await add(page, "shop.inventory_movement");

  await rows.next();
  await expect(page.getByTitle("Cancel loading")).toBeVisible();
  await rows.cancel();
  await expect(page.locator(".data-view-statusline-text")).toHaveText(
    "Loading cancelled. Refresh to load the rows again.",
  );
  await page.waitForTimeout(300);
  await expect(page.getByText(/This SQL result is closed/u)).toHaveCount(0);
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
  const keys = page.getByRole("menuitemcheckbox", { name: /^\d+ key columns$/u });
  await expect(keys).toHaveAttribute("aria-checked", "false");
  await keys.click();

  await expect(page.getByRole("columnheader", { name: /inventory_id/u })).toBeVisible();
  await keys.click();
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

test("moves rows out through a dialog of their own", async ({ page }) => {
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
  await expect(dialog.getByRole("radio", { name: /Entire query/u })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "CSV" })).toBeVisible();
  await expect(dialog.locator(".export-preview")).not.toBeEmpty();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
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
  const drawer = page.getByRole("menu", { name: "Pending changes" });
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

  // The keyboard cursor starts in the first cell, but it is not an actionable selection until the
  // reader explicitly picks cells or rows.
  await expect(bar.selection).toHaveText("Nothing selected");
  await expect(bar.remove).toBeDisabled();

  await selectRows(page, 1, 3);

  await expect(bar.selection).toHaveText("3 rows selected");
  await expect(page.locator("th.row-gutter.selected")).toHaveCount(3);
  // The band reads across every column, not only down the gutter.
  await expect(page.locator("tbody tr.row-selected")).toHaveCount(3);
  await expect(bar.remove).toBeEnabled();

  // A server sort replaces the rows under their coordinates, so it must clear the selection
  // before those coordinates could designate different database keys.
  await page.locator("button.column-sort").first().click();
  await expect(bar.selection).toHaveText("Nothing selected");
  await expect(bar.remove).toBeDisabled();

  await selectRows(page, 1, 3);
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
  const drawer = page.getByRole("menu", { name: "Pending changes" });
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
  const drawer = page.getByRole("menu", { name: "Pending changes" });
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
  const opener = page.getByRole("button", { name: "Export rows to a file…" });
  await opener.click();

  // The reader's selection is the scope offered first, and it says how much it covers.
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await expect(dialog.getByRole("radio", { name: /The selection/u })).toBeChecked();
  await expect(dialog.getByText(/The selection/u).locator("..")).toContainText("3 rows");

  // And the preview is the file: a header line, then the three rows picked out.
  const preview = dialog.locator(".export-preview");
  await expect(preview).toContainText("label,line1");
  expect((await preview.textContent())?.trim().split("\n")).toHaveLength(4);
  await dialog.getByRole("button", { name: "Copy preview" }).click();
  expect(await readClipboard(page)).toBe(await preview.textContent());
  await expect(dialog.getByRole("button", { name: "Preview copied" })).toBeVisible();

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
  await expect(preview).toContainText("| ---");
  await dialog.getByRole("radio", { name: "JSON" }).check();
  await expect(preview).toContainText('"label"');
  expect(await where()).toBe(before);
  await dialog.getByRole("button", { name: "Export" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
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
  await expect(joined.getByText("Requires a single table.")).toBeVisible();
});

test("writes the rows the reader picked out, in the shape they chose", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  await selectRows(page, 0, 1);
  await openExport(page);
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await dialog.getByRole("radio", { name: "TSV" }).check();
  const preview = dialog.locator(".export-preview");
  await expect(preview).toContainText("label\tline1");
  const written = (await preview.textContent()) ?? "";
  await dialog.getByRole("button", { name: "Export" }).click();

  await expect(page.locator(".data-view-statusline-text")).toContainText(/Exported 2 rows/u);
  // The file holds what the preview showed: it is written by the same module that showed it.
  const file = join(EXPORTS, "address.tsv");
  await expect(async () => expect(existsSync(file)).toBe(true)).toPass();
  expect(readFileSync(file, "utf8").trim()).toBe(written.trim());
});

test("leaves a hidden column out of what it writes", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  // Hidden through the columns menu, the way a reader hides one.
  await openColumns(page);
  const column = page.getByRole("menuitemcheckbox", { name: "city" });
  await column.click();
  await expect(column).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await openExport(page);
  const dialog = page.getByRole("dialog", { name: "Export rows" });
  await dialog.getByRole("radio", { name: "TSV" }).check();
  const preview = (await dialog.locator(".export-preview").textContent()) ?? "";
  await dialog.getByRole("button", { name: "Export" }).click();

  /*
   * A column the reader cannot see is not a column they asked to be given. What the preview shows
   * and what the file holds are the same thing, so neither may carry it.
   */
  expect(preview).not.toContain("city");
  const file = join(EXPORTS, "address.tsv");
  await expect(async () => expect(existsSync(file)).toBe(true)).toPass();
  expect(readFileSync(file, "utf8")).not.toContain("city");
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

test("offers to export where rows can be read, and does not offer to import at all", async ({
  page,
}) => {
  await openEmpty(page);

  // Reading rows out of a file is not built yet, so nothing offers it — not even refused.
  await expect(page.getByTitle(/Import rows|can only be imported/u)).toHaveCount(0);

  // Nothing to export yet, and the control says so rather than opening on nothing.
  await expect(page.getByTitle("Export rows to a file…")).toBeDisabled();

  await add(page, "shop.address");
  await expect(page.getByTitle("Export rows to a file…")).toBeEnabled();

  await add(page, "shop.warehouse");

  // Rows are still readable over a join; only writing them back needs one table to own them.
  await expect(page.getByTitle("Export rows to a file…")).toBeEnabled();
});
