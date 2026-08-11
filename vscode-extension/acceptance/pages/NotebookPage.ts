import { expect, type Locator, type Page } from "@playwright/test";
import type { ActiveNotebookSnapshot } from "../fixtures/vscode";

const NOTEBOOK_EDITOR = ".notebookOverlay.notebook-editor";
const NOTEBOOK_CELL = `${NOTEBOOK_EDITOR} .monaco-list-row`;

export class NotebookPage {
  constructor(
    private readonly page: Page,
    private readonly inspectActiveNotebook: () => Promise<ActiveNotebookSnapshot | undefined>,
  ) {}

  get editor(): Locator {
    return this.page.locator(NOTEBOOK_EDITOR);
  }

  get cells(): Locator {
    return this.page.locator(NOTEBOOK_CELL);
  }

  cell(index: number): Locator {
    return this.cells.nth(index);
  }

  private async toolbarAction(kind: "Code" | "Markdown"): Promise<Locator> {
    const action = this.editor
      .locator(".notebook-toolbar-container")
      .getByRole("button", {
        name: new RegExp(`^Add ${kind} Cell(?:\\s*\\(.+\\))?$`, "u"),
      })
      .filter({ visible: true });
    await expect(action, `The active notebook must expose one Add ${kind} Cell action`).toHaveCount(
      1,
      { timeout: 5_000 },
    );
    return action;
  }

  async activateLatestScratchpad(): Promise<void> {
    const tab = this.page.getByRole("tab", { name: /^Scratch \d+\.pgsql-notebook$/u }).last();
    await expect(tab).toBeVisible({ timeout: 5_000 });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    await expect(this.editor).toBeVisible({ timeout: 5_000 });
  }

  async addMarkdownCell(): Promise<Locator> {
    const previousCount = await this.cells.count();
    const action = await this.toolbarAction("Markdown");
    await expect(action).toBeVisible({ timeout: 5_000 });
    await action.click();
    await expect(this.cells).toHaveCount(previousCount + 1, { timeout: 5_000 });
    return this.cell(previousCount);
  }

  async addCodeCell(): Promise<Locator> {
    const previousCount = await this.cells.count();
    const action = await this.toolbarAction("Code");
    await expect(action).toBeVisible({ timeout: 5_000 });
    await action.click();
    await expect(this.cells).toHaveCount(previousCount + 1, { timeout: 5_000 });
    return this.cell(previousCount);
  }

  async typeInCell(cell: Locator, value: string): Promise<void> {
    const editor = cell.locator(".monaco-editor");
    await editor.click();
    await this.page.keyboard.insertText(value);
  }

  async renderMarkdown(cell: Locator): Promise<void> {
    await cell.locator(".monaco-editor").click();
    await this.page.keyboard.press("Control+Enter");
  }

  async executeCode(cell: Locator): Promise<void> {
    await cell
      .getByRole("button", { name: /Execute Cell/ })
      .first()
      .click();
  }

  async resultFrame(): Promise<import("@playwright/test").Frame> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if ((await frame.locator(".sql-result").count()) > 0) return frame;
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error("The SQL result renderer did not appear within 10000 ms");
  }

  async frameContainingText(text: string): Promise<import("@playwright/test").Frame> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if ((await frame.getByText(text, { exact: true }).count()) > 0) return frame;
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error(`No VS Code frame rendered ${JSON.stringify(text)} within 5000 ms`);
  }

  async renderedTextCount(text: RegExp): Promise<number> {
    let count = 0;
    for (const frame of this.page.frames()) count += await frame.getByText(text).count();
    return count;
  }

  snapshot(): Promise<ActiveNotebookSnapshot | undefined> {
    return this.inspectActiveNotebook();
  }
}
