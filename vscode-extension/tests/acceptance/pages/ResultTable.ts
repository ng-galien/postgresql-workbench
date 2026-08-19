import { expect, type Frame, type Locator } from "@playwright/test";

/**
 * The result table, wherever it is shown. The Scratchpad output, the Data View and the debugger
 * output render the same grid and the same navigation, so one page object drives all three: give
 * it the frame or the region that holds one.
 */
export class ResultTable {
  constructor(private readonly root: Frame | Locator) {}

  /** The rows currently rendered. The grid virtualises, so this is what a reader can see. */
  get rows(): Locator {
    return this.root.locator("tbody tr:not(.result-spacer)");
  }

  cell(rowIndex: number, columnIndex: number): Locator {
    return this.root.locator(`td[data-row="${rowIndex}"][data-column="${columnIndex}"]`);
  }

  /** Every cell holding exactly this text, whichever column it sits in. */
  cellsWithText(text: string): Locator {
    return this.root
      .locator("tbody td")
      .filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") });
  }

  columnHeader(name: string): Locator {
    return this.root.getByRole("button", { name: new RegExp(`^Sort .*${name}`, "u") });
  }

  async expectColumns(names: readonly string[]): Promise<void> {
    await expect(this.root.locator("thead .column-title")).toHaveText([...names], {
      timeout: 5_000,
    });
  }

  /** The row count the navigation shows: `Rows 1–200 · more available`, `1000 rows`, and so on. */
  summary(text: string): Locator {
    return this.root.getByText(text, { exact: true });
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

  /** Opens the cell inspector on a cell that carries more than the grid shows. */
  async inspect(rowIndex: number, columnIndex: number): Promise<Locator> {
    await this.cell(rowIndex, columnIndex).locator(".cell-value.inspectable").click();
    const detail = this.root.locator(".result-detail");
    await expect(detail).toBeVisible({ timeout: 5_000 });
    return detail;
  }

  private command(label: string): Locator {
    return this.root.getByRole("button", { name: label, exact: true });
  }
}
