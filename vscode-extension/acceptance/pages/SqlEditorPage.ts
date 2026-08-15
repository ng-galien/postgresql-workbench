import type { Locator, Page } from "@playwright/test";
import type { ActiveTextEditorSnapshot } from "../fixtures/vscode";

export class SqlEditorPage {
  constructor(
    private readonly page: Page,
    private readonly inspectActiveTextEditor: () => Promise<ActiveTextEditorSnapshot | undefined>,
  ) {}

  get editor(): Locator {
    return this.page.locator(".editor-group-container.active .monaco-editor:visible").first();
  }

  async formatDocument(): Promise<void> {
    await this.editor.click();
    await this.page.keyboard.press("Shift+Alt+F");
  }

  async requestCompletion(): Promise<void> {
    await this.editor.click();
    await this.page.keyboard.press("Control+Space");
  }

  suggestion(label: RegExp): Locator {
    return this.page.locator(".suggest-widget:visible").getByText(label).first();
  }

  snapshot(): Promise<ActiveTextEditorSnapshot | undefined> {
    return this.inspectActiveTextEditor();
  }
}
