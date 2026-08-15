import { expect, type Locator } from "@playwright/test";
import { currentPage, type PageProvider } from "./PageProvider";

export class QuickInput {
  constructor(private readonly pageProvider: PageProvider) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  get input(): Locator {
    return this.page.locator(".quick-input-widget:visible input:visible");
  }

  async chooseAndClose(label: RegExp): Promise<void> {
    await this.choose(label);
    await expect(this.page.locator(".quick-input-widget:visible")).toHaveCount(0, {
      timeout: 5_000,
    });
  }

  async chooseThenInput(label: RegExp, prompt?: RegExp): Promise<void> {
    await this.choose(label);
    await this.input.waitFor({ state: "visible", timeout: 5_000 });
    if (prompt) {
      await expect(this.input).toHaveAttribute("aria-label", prompt, { timeout: 5_000 });
    }
  }

  private async choose(label: RegExp): Promise<void> {
    const visibleList = this.page.locator(".quick-input-list:visible");
    const options = visibleList.locator(".monaco-list-row");
    await options.first().waitFor({ state: "visible", timeout: 5_000 });
    let previousSignature: string | undefined;
    try {
      await expect
        .poll(
          async () => {
            const texts = await options.allInnerTexts();
            const expression = new RegExp(label.source, label.flags);
            const matches = texts.filter((text) => {
              expression.lastIndex = 0;
              return expression.test(text);
            });
            const signature = JSON.stringify(texts);
            const stable = matches.length === 1 && signature === previousSignature;
            previousSignature = signature;
            return stable;
          },
          {
            timeout: 5_000,
            message: `Quick Pick options must stabilize on exactly one match for ${label}`,
          },
        )
        .toBe(true);
    } catch (error) {
      throw new Error(
        `Expected one stable Quick Pick option matching ${label}; visible options: ${JSON.stringify(await options.allInnerTexts())}`,
        { cause: error },
      );
    }
    const matchingLabel = new RegExp(label.source, label.flags.replace("g", ""));
    const match = options.filter({ hasText: matchingLabel });
    await expect(match).toHaveCount(1, { timeout: 5_000 });
    await match.first().click();
    await expect(visibleList).toHaveCount(0, {
      timeout: 5_000,
    });
  }

  async cancel(): Promise<void> {
    await this.input.waitFor({ state: "visible", timeout: 5_000 });
    await this.input.press("Escape");
    await expect(this.page.locator(".quick-input-widget:visible")).toHaveCount(0, {
      timeout: 5_000,
    });
  }

  async fill(value: string): Promise<void> {
    await this.input.waitFor({ state: "visible", timeout: 5_000 });
    await this.input.fill(value);
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

  async submitSecret(value: string, prompt: RegExp): Promise<void> {
    const widget = this.page.locator(".quick-input-widget:visible");
    await this.input.waitFor({ state: "visible", timeout: 5_000 });
    await expect(this.input).toHaveAttribute("type", "password", { timeout: 5_000 });
    await expect(widget).toContainText(prompt, { timeout: 5_000 });
    await this.input.fill(value);
    await this.input.press("Enter");
    await this.input.waitFor({ state: "hidden", timeout: 5_000 });
  }
}
