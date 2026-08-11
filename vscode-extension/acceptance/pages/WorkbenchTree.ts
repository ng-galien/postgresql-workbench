import { expect, type Locator, type Page } from "@playwright/test";

export class WorkbenchTree {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    const sidebarTitle = this.page.locator('[id="workbench.parts.sidebar"] .composite.title h2');
    if (/PostgreSQL Workbench/i.test((await sidebarTitle.textContent().catch(() => "")) ?? "")) {
      return;
    }
    const control = this.page
      .locator(".activitybar")
      .locator('[aria-label*="PostgreSQL Workbench"], [title*="PostgreSQL Workbench"]')
      .first();
    await control.waitFor({ state: "visible", timeout: 5_000 });
    await control.click();
    await sidebarTitle
      .filter({ hasText: /PostgreSQL Workbench/i })
      .waitFor({ state: "visible", timeout: 5_000 });
  }

  item(label: RegExp): Locator {
    return this.page.locator('[role="treeitem"]').filter({ hasText: label }).first();
  }

  headerAction(label: RegExp): Locator {
    return this.page
      .locator('[id="workbench.parts.sidebar"] .composite.title')
      .getByLabel(label)
      .first();
  }

  async clickHeaderAction(label: RegExp): Promise<void> {
    const action = this.headerAction(label);
    await action.waitFor({ state: "visible", timeout: 5_000 });
    await action.click();
  }

  async expand(label: RegExp): Promise<void> {
    const item = this.item(label);
    await item.waitFor({ state: "visible", timeout: 5_000 });
    await item.scrollIntoViewIfNeeded();
    if ((await item.getAttribute("aria-expanded")) === "true") return;
    await item.locator(".monaco-tl-twistie").click();
    await expect(item).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }

  async expandPath(labels: RegExp[]): Promise<void> {
    for (const label of labels) await this.expand(label);
  }

  async select(label: RegExp): Promise<void> {
    const item = this.item(label);
    await item.waitFor({ state: "visible", timeout: 5_000 });
    await item.scrollIntoViewIfNeeded();
    await item.locator(".monaco-tl-contents").click();
  }
}
