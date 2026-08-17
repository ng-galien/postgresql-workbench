import { expect, type Locator } from "@playwright/test";
import type { ActiveTextEditorSnapshot, VSCodeInstance } from "../fixtures/vscode";
import { currentPage, type PageProvider } from "./PageProvider";

export class SqlEditorPage {
  constructor(
    private readonly pageProvider: PageProvider,
    private readonly inspectActiveTextEditor: () => Promise<ActiveTextEditorSnapshot | undefined>,
    private readonly executeCommand: VSCodeInstance["executeCommand"],
  ) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  get editor(): Locator {
    return this.page.locator(".editor-group-container.active .monaco-editor:visible").first();
  }

  async formatDocument(): Promise<void> {
    await this.editor.click();
    await this.executeCommand("editor.action.formatDocument");
  }

  async associateDocumentAutomatically(connection: RegExp): Promise<void> {
    const assigned = this.editor.getByRole("button", { name: connection }).first();
    if (await assigned.isVisible()) return;
    const choose = this.editor.getByRole("button", { name: /Choose Document Association/ }).first();
    await expect(choose).toBeVisible({ timeout: 5_000 });
    await choose.click();
    await expect(assigned).toBeVisible({ timeout: 5_000 });
  }

  async requestCompletion(): Promise<void> {
    await this.editor.click();
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

  snapshot(): Promise<ActiveTextEditorSnapshot | undefined> {
    return this.inspectActiveTextEditor();
  }

  private completionWidget(): Locator {
    return this.editor.locator(".suggest-widget:visible");
  }
}
