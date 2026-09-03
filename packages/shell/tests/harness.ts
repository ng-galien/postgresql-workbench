import { expect, type Locator, type Page } from "@playwright/test";
import { ResultTable } from "../../views/testing/ResultTable.js";

/**
 * What every grid journey needs before it can say anything: a view opened on nothing, a relation
 * composed into it, edit mode turned on, and the reader's own clipboard. Shared so the Data View
 * journey and the grid journey drive the same application the same way.
 */

/** Opens an empty view: the shell is one running application, so each scenario starts it over. */
export async function openEmpty(page: Page) {
  await page.request.post("/reset");
  await page.goto("/data-view");
  await expect(page.getByText("The query is empty")).toBeVisible();
}

/** The official Monaco surface used by the shell, addressed through its accessible editor name. */
export class MonacoEditor {
  readonly root: Locator;

  constructor(
    private readonly page: Page,
    ariaLabel: string,
  ) {
    const accessibleControl = page.getByRole("textbox", { name: ariaLabel, exact: true });
    // TypeFox disposes an editor through its asynchronous queue. If a panel has just been closed
    // and reopened, the newest editor is the live surface while the previous DOM may still be
    // leaving the page.
    this.root = page.locator(".monaco-editor").filter({ has: accessibleControl }).last();
  }

  async waitUntilReady(): Promise<void> {
    await expect(this.root).toBeVisible();
  }

  async replace(text: string): Promise<void> {
    await this.waitUntilReady();
    if (await this.completionWidget().isVisible()) await this.page.keyboard.press("Escape");
    await this.root.click();
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await this.page.keyboard.insertText(text);
    await expect.poll(() => this.text()).toBe(text);
  }

  async text(): Promise<string> {
    await this.waitUntilReady();
    await this.root.click();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await this.page.keyboard.press(`${modifier}+a`);
    await this.page.keyboard.press(`${modifier}+c`);
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  async submit(): Promise<void> {
    await this.page.keyboard.press("Enter");
  }

  async requestCompletions(): Promise<void> {
    await this.root.click();
    await this.page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
    );
    await this.page.keyboard.press("Control+Space");
    await expect(this.completionWidget()).toBeVisible();
  }

  completionWidget(): Locator {
    return this.root.locator(".suggest-widget:visible");
  }

  suggestions(): Locator {
    return this.completionWidget().locator(".monaco-list-row");
  }

  suggestion(label: string): Locator {
    return this.suggestions()
      .filter({ has: this.page.getByText(label, { exact: true }) })
      .first();
  }

  async accept(label: string): Promise<void> {
    const proposal = this.suggestion(label);
    await expect(proposal).toBeVisible();
    await proposal.click();
  }

  /** Computed colours of visible leaf tokens spelling exactly `text`. */
  tokenColours(text: string): Promise<string[]> {
    return this.root.locator(".view-lines").evaluate((lines, token) => {
      const colours = new Set<string>();
      for (const span of lines.querySelectorAll("span")) {
        if (span.children.length === 0 && span.textContent === token) {
          colours.add(getComputedStyle(span).color);
        }
      }
      return [...colours];
    }, text);
  }

  /** Browser-resolved colour of a host-overridable presentation role. */
  presentationColour(
    role:
      | "--pgw-syntax-binding"
      | "--pgw-syntax-column"
      | "--pgw-syntax-keyword"
      | "--pgw-syntax-string"
      | "--pgw-syntax-type",
  ): Promise<string> {
    return this.page.evaluate((property) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${property})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }, role);
  }
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

/** Selects whole rows the way a reader does: in the gutter, extending with shift. */
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

/** The visible column names, in the order they are shown, paired with the ordinal each one uses. */
export async function columns(page: Page): Promise<{ name: string; ordinal: string }[]> {
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
export function cursor(page: Page): Promise<string> {
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

/** The ordinal a column is drawn at, by its name — what every cell locator is built from. */
export function ordinalOf(
  shown: readonly { name: string; ordinal: string }[],
  name: string,
): string {
  const column = shown.find((candidate) => candidate.name === name);
  if (!column) throw new Error(`The view must show a ${name} column`);
  return column.ordinal;
}

/** The rows the result holds, without the spacers the virtualised grid draws around them. */
export function bodyRows(page: Page) {
  return page.locator("tbody tr:not(.result-spacer)");
}
