import { expect, type Page, test } from "@playwright/test";
import { add, editBar, enterEditMode, openEmpty, readClipboard, selectRows } from "./harness.js";

/**
 * The grid itself, driven the way a reader drives it: the keys, the selection, the clipboard, and
 * the three things a cell of a row being added can hold. The Data View journey next door composes
 * queries; this one only ever asks what the grid does with a keystroke and a row.
 */

/** The visible column names, in the order they are shown, paired with the ordinal each one uses. */
async function columns(page: Page): Promise<{ name: string; ordinal: string }[]> {
  const names = await page.locator("thead th:not(.row-gutter)").allInnerTexts();
  const ordinals = await page
    .locator("tbody tr:not(.result-spacer)")
    .first()
    .locator("td[data-column]")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-column") ?? ""));
  return names.map((name, index) => ({
    name: name.split("\n")[0]?.trim() ?? "",
    ordinal: ordinals[index] ?? "",
  }));
}

/** Where the cursor stands: the anchor cell, or the gutter when whole rows are selected. */
function cursor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gutter = document.querySelector("th.row-gutter.selected");
    const anchor = document.querySelector("td.anchor");
    const cell = anchor ?? gutter;
    if (!cell) return "nothing";
    const row = cell.closest("tr");
    const index = row ? [...(row.parentElement?.children ?? [])].indexOf(row) : -1;
    if (!anchor) return `gutter:${index}`;
    return `${index}:${anchor.getAttribute("data-column")}`;
  });
}

test("walks the rows and the columns with the arrows, and jumps to the ends", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");

  await page.locator('td[data-row="1"][data-column="2"]').click();
  expect(await cursor(page)).toBe("1:2");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  expect(await cursor(page)).toBe("2:3");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowLeft");
  expect(await cursor(page)).toBe("1:2");

  // End is the last column of the row, Home the first — the gutter is one step further left still.
  await page.keyboard.press("End");
  const last = (await columns(page)).at(-1)?.ordinal;
  expect(await cursor(page)).toBe(`1:${last}`);
  await page.keyboard.press("Home");
  const first = (await columns(page))[0]?.ordinal;
  expect(await cursor(page)).toBe(`1:${first}`);

  // A page is as many rows as the window shows, so it never walks past what there is.
  await page.keyboard.press("PageDown");
  expect(await cursor(page)).not.toBe(`1:${first}`);
  await page.keyboard.press("PageUp");
  expect(await cursor(page)).toBe(`0:${first}`);
});

test("copies two whole rows and carries them into two new ones", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);

  const rows = page.locator("tbody tr:not(.result-spacer)");
  const wanted = [
    await rows.nth(0).locator("td[data-column]").allTextContents(),
    await rows.nth(1).locator("td[data-column]").allTextContents(),
  ];

  await selectRows(page, 0, 1);
  await page.keyboard.press("ControlOrMeta+c");
  expect((await readClipboard(page)).split("\n")).toHaveLength(2);

  // The reader's own way round: make the room first, then paste into it.
  await bar.add.click();
  await bar.add.click();
  const added = page.locator("tbody tr.added");
  await expect(added).toHaveCount(2);

  await added.nth(0).locator("td[data-column]").first().click();
  await page.keyboard.press("ControlOrMeta+v");

  await expect(added).toHaveCount(2);
  const landed = [
    await added.nth(0).locator("td[data-column]").allTextContents(),
    await added.nth(1).locator("td[data-column]").allTextContents(),
  ];
  // A column the source held nothing in is left to the database rather than set to an empty text.
  const expected = wanted.map((row) => row.map((text) => (text === "NULL" ? "DEFAULT" : text)));
  expect(landed).toEqual(expected);
});

test("copies the cells of one column alone, and pastes them down another", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);

  const city = (await columns(page)).find((column) => column.name === "city");
  const label = (await columns(page)).find((column) => column.name === "label");
  if (!city || !label) throw new Error("The address view must show its city and label columns");

  // Three cells of one column, and nothing beside them: a rectangle one column wide.
  await page.locator(`td[data-row="0"][data-column="${city.ordinal}"]`).click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(editBar(page).selection).toHaveText("3 rows × 1 column");

  await page.keyboard.press("ControlOrMeta+c");
  const copied = (await readClipboard(page)).split("\n");
  expect(copied).toHaveLength(3);
  // One column carries no tab: what is copied is the column, not the rows it was taken from.
  expect(copied.join("")).not.toContain("\t");

  await page.locator(`td[data-row="0"][data-column="${label.ordinal}"]`).click();
  await page.keyboard.press("ControlOrMeta+v");

  for (const [index, value] of copied.entries()) {
    await expect(
      page.locator(`td[data-row="${index}"][data-column="${label.ordinal}"]`),
    ).toHaveText(value);
  }
});

test("tells apart the three things a cell of a new row can hold", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.stock_check");
  await enterEditMode(page);
  const bar = editBar(page);
  const shown = await columns(page);
  await bar.add.click();
  const added = page.locator("tbody tr.added").first();
  await expect(added).toHaveCount(1);
  const cell = (name: string) =>
    added.locator(`td[data-column="${shown.find((column) => column.name === name)?.ordinal}"]`);
  const mark = "Chloé — three states";

  await cell("counted_by").dblclick();
  await page.keyboard.type(mark);
  await page.keyboard.press("Enter");

  // Looking at a cell is not filling it: the column stays out of the INSERT and takes its default.
  await cell("status").dblclick();
  await page.keyboard.press("Enter");
  await expect(cell("status")).toHaveText("DEFAULT");

  // NULL is a value the reader gives, and it is not the default the table would have given.
  await cell("note").dblclick();
  await page.locator('.cell-editor button[title="Insert NULL"]').click();
  await expect(cell("note")).toHaveText("NULL");

  // An empty text is a third thing again: typed, then cleared, and meant.
  await cell("checked_at").dblclick();
  await page.locator('.cell-editor button[title="Leave it to the database"]').click();
  await expect(cell("checked_at")).toHaveText("DEFAULT");

  await bar.apply.click();
  await expect(page.locator("tbody tr.added")).toHaveCount(0);

  // What the database holds is the proof: `status` took its default, `note` holds nothing.
  const written = page.locator("tbody tr:not(.result-spacer)", { hasText: mark }).first();
  await expect(
    written.locator(`td[data-column="${shown.find((c) => c.name === "status")?.ordinal}"]`),
  ).toHaveText("pending");
  await expect(
    written.locator(`td[data-column="${shown.find((c) => c.name === "note")?.ordinal}"]`),
  ).toHaveText("NULL");

  // And back out again, so the database is left as it was found.
  await written.locator("th").click();
  await bar.remove.click();
  await bar.apply.click();
  await expect(page.locator("tbody tr", { hasText: mark })).toHaveCount(0);
});

test("gives a value back to NULL on a row the result already held", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.stock_check");
  await enterEditMode(page);
  const bar = editBar(page);
  const shown = await columns(page);
  const at = (name: string) => shown.find((column) => column.name === name)?.ordinal;
  const mark = "Chloé — back to NULL";

  // A row of its own to work on: a journey that writes must not depend on what another one left.
  await bar.add.click();
  const added = page.locator("tbody tr.added").first();
  await added.locator(`td[data-column="${at("counted_by")}"]`).dblclick();
  await page.keyboard.type(mark);
  await page.keyboard.press("Enter");
  await bar.apply.click();
  const written = page.locator("tbody tr:not(.result-spacer)", { hasText: mark }).first();
  const status = written.locator(`td[data-column="${at("status")}"]`);
  await expect(status).toHaveText("pending");

  // A row already written holds something, if only NULL: it has no default to be left to.
  await status.dblclick();
  await expect(page.locator(".cell-editor button")).toHaveCount(1);
  await page.locator('.cell-editor button[title="Insert NULL"]').click();
  await expect(status).toHaveText("NULL");
  await expect(bar.changes).toHaveText("1");

  await bar.apply.click();
  await expect(status).toHaveText("NULL");
  await expect(bar.changes).toBeDisabled();

  await written.locator("th").click();
  await bar.remove.click();
  await bar.apply.click();
  await expect(page.locator("tbody tr", { hasText: mark })).toHaveCount(0);
});
