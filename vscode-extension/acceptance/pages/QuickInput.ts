import { expect, type Locator, type Page } from "@playwright/test";

export class QuickInput {
  constructor(private readonly page: Page) {}

  get input(): Locator {
    return this.page.locator(".quick-input-widget input");
  }

  async chooseOption(label: RegExp): Promise<void> {
    const option = this.page
      .locator(".quick-input-list .monaco-list-row")
      .filter({ hasText: label });
    await option.first().waitFor({ state: "visible", timeout: 5_000 });
    await option.first().click();
  }

  async submit(value: string, prompt?: RegExp): Promise<void> {
    await this.input.waitFor({ state: "visible", timeout: 5_000 });
    if (prompt) {
      await expect(this.input).toHaveAttribute("aria-label", prompt, { timeout: 5_000 });
    }
    await this.input.fill(value);
    await this.input.press("Enter");
    await this.input.waitFor({ state: "hidden", timeout: 5_000 });
  }
}
