import { expect, type Page } from "@playwright/test";
import { ResultTable } from "../../views/testing/ResultTable.js";

/**
 * What every grid journey needs before it can say anything: a view opened on nothing, a relation
 * composed into it, edit mode turned on, and the reader's own clipboard. Shared so the Data View
 * journey and the grid journey drive the same application the same way.
 */

/** Opens an empty view: the shell is one running application, so each scenario starts it over. */
export async function openEmpty(page: Page) {
  await page.request.post("/reset");
  await page.goto("/");
  await expect(page.getByText("The query is empty")).toBeVisible();
}

/** Adds a relation from the additions menu, and waits for what it composed to load. */
export async function add(page: Page, relation: string): Promise<ResultTable> {
  await page.getByTitle(/Add (the first table|a column or a related table)/u).click();
  await page.getByTitle(new RegExp(`^(Start the query with|JOIN) ${relation}(\\s|$)`, "u")).click();
  await expect(page.getByTitle(new RegExp(`^${relation} — its columns`, "u"))).toBeVisible();
  return new ResultTable(page);
}

/** Opens the columns menu, whose control names how many columns are hidden right now. */
export async function openColumns(page: Page) {
  await page.getByTitle(/^(Show or hide columns|Columns \()/u).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** Turns editing on: the gutter, the edit bar and cell editing all follow that one control. */
export async function enterEditMode(page: Page) {
  await page.getByTitle("Edit mode", { exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Row editing" })).toBeVisible();
}

/** Selects whole rows the way a reader does: in the gutter, extending with shift. */
/** Puts text on the clipboard the reader will paste from. */
export async function putOnClipboard(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

/** Reads back what the grid put on the clipboard. */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Opens the export dialog from the toolbar. */
export async function openExport(page: Page) {
  await page.getByRole("button", { name: /Export rows to a file/u }).click();
  await expect(page.getByRole("dialog", { name: "Export rows" })).toBeVisible();
}

export async function selectRows(page: Page, first: number, last = first) {
  const gutters = page.locator("tbody th.row-gutter");
  await gutters.nth(first).click();
  if (last !== first) await gutters.nth(last).click({ modifiers: ["Shift"] });
}

/** The edit bar's own controls, by the words on them. */
export function editBar(page: Page) {
  const bar = page.getByRole("toolbar", { name: "Row editing" });
  return {
    selection: bar.locator(".edit-bar-selection"),
    add: bar.getByRole("button", { name: /Add row/u }),
    remove: bar.getByRole("button", { name: /Delete/u }),
    changes: bar.locator(".edit-bar-button.count"),
    apply: bar.getByRole("button", { name: /Apply/u }),
  };
}
