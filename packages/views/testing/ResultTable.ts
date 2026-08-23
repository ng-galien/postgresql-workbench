/*
 * Types only. Two harnesses drive this page object — the shell lane from the repository root and
 * the VS Code lane from the extension — and each resolves its own Playwright: importing a value
 * from here loaded both at once, which Playwright refuses. Nothing here needs one.
 */
import type { Frame, Locator, Page } from "@playwright/test";
import { escapeRegExp } from "./text.js";

/**
 * The result table, wherever it is shown and whoever drives it. The Scratchpad output, the Data
 * View and the debugger output render the same grid and the same navigation, so one page object
 * drives all three — inside VS Code, or in a browser against the composition shell. Give it the
 * frame, the page, or the region that holds one.
 */
export class ResultTable {
  constructor(private readonly root: Frame | Locator | Page) {}

  cell(rowIndex: number, columnIndex: number): Locator {
    return this.root.locator(`td[data-row="${rowIndex}"][data-column="${columnIndex}"]`);
  }

  /** Every cell holding exactly this text, whichever column it sits in. */
  cellsWithText(text: string): Locator {
    return this.root
      .locator("tbody td")
      .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`, "u") });
  }

  /** The row count the navigation shows: `Rows 1–200 · more available`, `1000 rows`, and so on. */
  /** What a surface says in prose about how much of the result it is showing. */
  summary(text: string): Locator {
    return this.root.getByText(text, { exact: true });
  }

  /**
   * Where the reader is, as the slot between the two paging arrows says it: as few characters as
   * it can be said in, so that paging never moves the arrows either side of it.
   */
  get rowRange(): Locator {
    return this.root.locator(".result-navigation-summary");
  }

  async next(): Promise<void> {
    await this.command("Next page").click();
  }

  async previous(): Promise<void> {
    await this.command("Previous page").click();
  }

  async loadAll(): Promise<void> {
    await this.root.getByRole("button", { name: /^Load every remaining row/u }).click();
  }

  async cancel(): Promise<void> {
    await this.command("Cancel loading").click();
  }

  private command(label: string): Locator {
    return this.root.getByRole("button", { name: label, exact: true });
  }
}
