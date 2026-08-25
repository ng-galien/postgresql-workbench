import { expect, test } from "@playwright/test";
import {
  add,
  columns,
  cursor,
  editBar,
  enterEditMode,
  openEmpty,
  putOnClipboard,
  readClipboard,
  selectRows,
} from "./harness.js";

/**
 * The grid itself, driven the way a reader drives it: the keys, the selection, the clipboard, and
 * the three things a cell of a row being added can hold. The Data View journey next door composes
 * queries; this one only ever asks what the grid does with a keystroke and a row.
 */

test("opens the editor on the row the cursor is on, added rows included", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await enterEditMode(page);
  const bar = editBar(page);

  await page.locator("tbody tr:not(.result-spacer) td").first().click();
  await bar.add.click();
  await bar.add.click();
  await expect(page.locator("tbody tr .row-gutter-state.added")).toHaveCount(2);

  /*
   * The arrows count through the rows waiting to be added and the loaded ones alike, so the row
   * under the cursor is not the row at that place among the loaded ones. Asked from the keys, the
   * editor used to open on whichever loaded row happened to sit at that number.
   */
  /*
   * Which row the editor opened on, said by what addresses it rather than by what numbers it: the
   * local id of a row waiting to be added counts up across the whole shell and is nobody's business
   * here, where the question is only whether the editor landed on the row the cursor was on.
   */
  const openedOn = () =>
    page.evaluate(() => {
      const cell = document.querySelector(".cell-editor")?.closest("td");
      if (!cell) return "none";
      return cell.hasAttribute("data-added-row")
        ? "added"
        : `loaded:${cell.getAttribute("data-row")}`;
    });

  await page.locator("tbody tr:has(.row-gutter-state.added) td").first().click();
  await page.keyboard.press("Enter");
  expect(await openedOn()).toBe("added");
  await page.keyboard.press("Escape");

  // And the loaded row under the cursor is the one it says, however many rows wait above it.
  await page.locator("tbody tr:not(:has(.row-gutter-state.added)) td").first().click();
  await page.keyboard.press("Enter");
  expect(await openedOn()).toBe("loaded:0");
});

test("walks onto the gutter with the arrows, and takes whole rows from there", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");

  await page.locator("tbody tr:not(.result-spacer) td").first().click();
  const gutter = page.locator("th.row-gutter.selected");
  await expect(gutter).toHaveCount(0);

  // The gutter is one step left of the first column. Standing on it is what selecting a whole row
  // means, so the reader never has to reach for the pointer to take one.
  await page.keyboard.press("ArrowLeft");
  await expect(gutter).toHaveCount(1);

  // Down the gutter walks whole rows, and a held shift extends the run of them.
  await page.keyboard.press("ArrowDown");
  await expect(gutter).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(gutter).toHaveCount(2);

  // One step right is the first column again, and the row selection is behind him.
  await page.keyboard.press("ArrowRight");
  await expect(gutter).toHaveCount(0);
});

test("gives the keyboard back when a cell editor closes", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.product");
  await enterEditMode(page);

  await page.locator("tbody tr:not(.result-spacer) td").nth(1).dblclick();
  await expect(page.locator(".cell-editor input, .cell-editor textarea")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cell-editor input, .cell-editor textarea")).toHaveCount(0);

  // Closing the editor unmounted the field the focus was in. Unless the grid takes it back, every
  // arrow after an edit goes to the page and the reader has to click to get the keyboard again.
  const rowOf = async () => Number((await cursor(page)).split(":")[0]);
  const before = await rowOf();
  await page.keyboard.press("ArrowDown");
  expect(await rowOf()).toBe(before + 1);
});

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
  const shown = await columns(page);
  const first = shown[0]?.ordinal;
  await page.keyboard.press("End");
  expect(await cursor(page)).toBe(`1:${shown.at(-1)?.ordinal}`);
  await page.keyboard.press("Home");
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

test("takes one change back out of the list, and the rows follow", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);
  const city = (await columns(page)).find((column) => column.name === "city");
  if (!city) throw new Error("The address view must show its city column");

  const rows = page.locator("tbody tr:not(.result-spacer)");
  const edited = rows.nth(0).locator(`td[data-column="${city.ordinal}"]`);
  const held = (await edited.innerText()).trim();

  // One of each kind waiting at once: a cell changed, a row going, a row arriving.
  await edited.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Marseille");
  await page.keyboard.press("Enter");
  await expect(edited).toHaveText("Marseille");
  await selectRows(page, 2);
  await bar.remove.click();
  await expect(page.locator("tbody tr.removed")).toHaveCount(1);
  await bar.add.click();
  await expect(page.locator("tbody tr.added")).toHaveCount(1);

  await bar.changes.click();
  const dismiss = page.getByRole("menu").locator(".menu-note-dismiss");
  await expect(dismiss).toHaveCount(3);

  /*
   * Reading the list is one thing; changing one's mind about a single line of it is another. What
   * the grid draws is these three lists and nothing else, so taking one out puts the rows back as
   * they were without the eight others being discarded with it.
   */
  await dismiss.nth(0).click();
  await expect(page.locator("tbody tr.removed")).toHaveCount(0);

  await dismiss.nth(0).click();
  await expect(edited).toHaveText(held);

  // The last one out closes the list: a drawer of changes with nothing left in it is not opened.
  await dismiss.nth(0).click();
  await expect(page.locator("tbody tr.added")).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(bar.changes).toBeDisabled();
});

test("holds a row waiting to go still, and lets it be copied all the same", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.address");
  await enterEditMode(page);
  const bar = editBar(page);
  const city = (await columns(page)).find((column) => column.name === "city");
  if (!city) throw new Error("The address view must show its city column");

  const row = page.locator("tbody tr:not(.result-spacer)").nth(1);
  const cell = row.locator(`td[data-column="${city.ordinal}"]`);
  const held = (await cell.innerText()).trim();

  await selectRows(page, 1);
  await bar.remove.click();
  await expect(row).toHaveClass(/removed/u);

  /*
   * A row provisioned to go holds nothing to change. The DELETE is written before the updates, so
   * an edit landing on it afterwards would guard against a row that has already left and roll the
   * whole transaction back — and it is one gesture away from being put back if that is the mistake.
   */
  await cell.dblclick();
  await expect(page.locator(".cell-editor")).toHaveCount(0);
  await expect(bar.changes).toHaveText("1");

  // Reading it is not writing to it: what is on its way out can still be taken down.
  await page.keyboard.press("ControlOrMeta+c");
  expect(await readClipboard(page)).toContain(held);

  // What cannot be typed into cannot be pasted into either: the values arrive the same way.
  await putOnClipboard(page, "Marseille");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(cell).toHaveText(held);
  await expect(bar.changes).toHaveText("1");

  // And putting it back makes it editable again, because the rule is about the row, not the cell.
  await selectRows(page, 1);
  await bar.remove.click();
  await expect(row).not.toHaveClass(/removed/u);
  await cell.dblclick();
  await expect(page.locator(".cell-editor")).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("gives a written column back to the default the table would have given it", async ({
  page,
}) => {
  await openEmpty(page);
  await add(page, "shop.stock_check");
  await enterEditMode(page);
  const bar = editBar(page);
  const shown = await columns(page);
  const at = (name: string) => shown.find((column) => column.name === name)?.ordinal;
  const mark = "Chloé — back to the default";

  await bar.add.click();
  const added = page.locator("tbody tr.added").first();
  await added.locator(`td[data-column="${at("counted_by")}"]`).dblclick();
  await page.keyboard.type(mark);
  await page.keyboard.press("Enter");
  await added.locator(`td[data-column="${at("status")}"]`).dblclick();
  await page.keyboard.type("done");
  await page.keyboard.press("Enter");
  await bar.apply.click();

  await expect(bar.changes).toBeDisabled();
  const written = page.locator("tbody tr:not(.result-spacer)", { hasText: mark }).first();
  const status = written.locator(`td[data-column="${at("status")}"]`);
  await expect(status).toHaveText("done");

  // A column with nothing of its own to fall back on is only ever given NULL.
  await written.locator(`td[data-column="${at("note")}"]`).dblclick();
  await expect(page.locator(".cell-editor button")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // One that has a default can be given back to it, which writes `= DEFAULT` and not NULL.
  await status.dblclick();
  await expect(page.locator(".cell-editor button")).toHaveCount(2);
  await page.locator('.cell-editor button[title="Leave it to the database"]').click();
  await expect(status).toHaveText("DEFAULT");

  // The list of what is waiting says the same thing the cell does, and not the NULL beside it.
  await bar.changes.click();
  await expect(page.getByRole("menu").locator(".pending-edit-value")).toHaveText("DEFAULT");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await bar.apply.click();
  await expect(status).toHaveText("pending");

  await written.locator("th").click();
  await bar.remove.click();
  await bar.apply.click();
  await expect(page.locator("tbody tr", { hasText: mark })).toHaveCount(0);
});

test("gives a value back to NULL, which is not the default beside it", async ({ page }) => {
  await openEmpty(page);
  await add(page, "shop.stock_check");
  await enterEditMode(page);
  const bar = editBar(page);
  const shown = await columns(page);
  const at = (name: string) => shown.find((column) => column.name === name)?.ordinal;
  const mark = "Chloé — back to NULL";

  await bar.add.click();
  const added = page.locator("tbody tr.added").first();
  await added.locator(`td[data-column="${at("counted_by")}"]`).dblclick();
  await page.keyboard.type(mark);
  await page.keyboard.press("Enter");
  await added.locator(`td[data-column="${at("status")}"]`).dblclick();
  await page.keyboard.type("done");
  await page.keyboard.press("Enter");
  await bar.apply.click();

  // The write is over when nothing is held any more; the rows are re-read on the way.
  await expect(bar.changes).toBeDisabled();
  const written = page.locator("tbody tr:not(.result-spacer)", { hasText: mark }).first();
  const status = written.locator(`td[data-column="${at("status")}"]`);
  await expect(status).toHaveText("done");

  // The column has a default, and NULL is offered beside it: the reader picks which one they mean.
  await status.dblclick();
  await expect(page.locator(".cell-editor button")).toHaveCount(2);
  await page.locator('.cell-editor button[title="Insert NULL"]').click();
  await expect(status).toHaveText("NULL");
  await expect(bar.changes).toHaveText("1");

  // NULL is written, not the 'pending' the table would have given: the two are not the same change.
  await bar.apply.click();
  await expect(status).toHaveText("NULL");
  await expect(bar.changes).toBeDisabled();

  await written.locator("th").click();
  await bar.remove.click();
  await bar.apply.click();
  await expect(page.locator("tbody tr", { hasText: mark })).toHaveCount(0);
});
