import { expect, type Locator } from "@playwright/test";
import type { ActiveNotebookSnapshot } from "../fixtures/vscode";
import { currentPage, type PageProvider } from "./PageProvider";

export class NotebookPage {
  constructor(
    private readonly pageProvider: PageProvider,
    private readonly inspectActiveNotebook: () => Promise<ActiveNotebookSnapshot | undefined>,
  ) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  get editor(): Locator {
    // VS Code portals notebook overlays outside the active editor group. The
    // accessible notebook list is the stable, user-visible surface.
    return this.page
      .getByRole("list", { name: /^Notebook /u })
      .filter({ visible: true })
      .first();
  }

  get cells(): Locator {
    return this.editor.getByRole("listitem");
  }

  cell(index: number): Locator {
    return this.cells.nth(index);
  }

  private async toolbarAction(kind: "Code" | "Markdown"): Promise<Locator> {
    const action = this.page
      .locator(".notebook-toolbar-container:visible")
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

  async closeActive(): Promise<void> {
    const activeGroup = this.page.locator(".editor-group-container.active");
    const tab = activeGroup
      .getByRole("tab", { name: /\.pgsql-notebook$/u })
      .and(activeGroup.locator('[aria-selected="true"]'))
      .first();
    await expect(tab).toBeVisible({ timeout: 5_000 });
    await tab.hover();
    await tab.locator(".codicon-close").click();
    await expect(tab).toHaveCount(0, { timeout: 5_000 });
  }

  async addMarkdownCell(): Promise<Locator> {
    const previousCount = (await this.snapshot())?.cells.length ?? 0;
    const action = await this.toolbarAction("Markdown");
    await expect(action).toBeVisible({ timeout: 5_000 });
    await action.click();
    await expect
      .poll(async () => (await this.snapshot())?.cells.length, { timeout: 5_000 })
      .toBe(previousCount + 1);
    await expect
      .poll(async () => (await this.snapshot())?.cells.at(-1)?.kind, { timeout: 5_000 })
      .toBe("markup");
    return this.cells.last();
  }

  async addCodeCell(): Promise<Locator> {
    const previousCount = (await this.snapshot())?.cells.length ?? 0;
    const action = await this.toolbarAction("Code");
    await expect(action).toBeVisible({ timeout: 5_000 });
    await action.click();
    await expect
      .poll(async () => (await this.snapshot())?.cells.length, { timeout: 5_000 })
      .toBe(previousCount + 1);
    await expect
      .poll(async () => (await this.snapshot())?.cells.at(-1)?.kind, { timeout: 5_000 })
      .toBe("code");
    return this.cells.last();
  }

  async typeInCell(cell: Locator, value: string): Promise<void> {
    const editor = cell.locator(".monaco-editor");
    await editor.click();
    await this.page.keyboard.insertText(value);
  }

  async renderMarkdown(cell: Locator): Promise<void> {
    await cell.hover();
    await cell
      .getByRole("button", { name: /Execute Cell/u })
      .first()
      .click();
    await expect(cell.locator(".monaco-editor:visible")).toHaveCount(0, { timeout: 5_000 });
  }

  async executeCode(cell: Locator): Promise<void> {
    await cell
      .getByRole("button", { name: /Execute Cell/ })
      .first()
      .click();
  }

  async requestCompletion(cell: Locator): Promise<void> {
    await cell.scrollIntoViewIfNeeded();
    await cell.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await cell.locator(".monaco-editor").click();
    await this.page.keyboard.press("Control+Space");
    await expect(this.completionWidget()).toBeVisible({ timeout: 5_000 });
  }

  suggestion(label: RegExp): Locator {
    return this.completionWidget().getByText(label).first();
  }

  async dismissCompletion(): Promise<void> {
    const widget = this.completionWidget();
    if ((await widget.count()) > 0) await this.page.keyboard.press("Escape");
    await expect(widget).toHaveCount(0, { timeout: 5_000 });
  }

  async resultFrame(expectedText: string | RegExp): Promise<import("@playwright/test").Frame> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        const result = frame
          .getByRole("region", { name: "PostgreSQL query result" })
          .filter({ visible: true });
        if (
          (await result.count()) > 0 &&
          (await result
            .getByText(expectedText, { exact: typeof expectedText === "string" })
            .count()) > 0
        ) {
          return frame;
        }
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error(
      `No visible PostgreSQL query result rendered ${String(expectedText)} within 10000 ms`,
    );
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

  private completionWidget(): Locator {
    return this.editor.locator(".suggest-widget:visible");
  }
}
