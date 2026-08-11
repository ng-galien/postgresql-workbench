import { expect, type Locator, type Page } from "@playwright/test";

export class WorkbenchTree {
  constructor(private readonly page: Page) {}

  item(label: RegExp): Locator {
    return this.page.getByRole("treeitem").filter({ hasText: label }).first();
  }

  headerAction(label: RegExp): Locator {
    return this.page.getByLabel(label).first();
  }

  async clickHeaderAction(label: RegExp): Promise<void> {
    const action = this.headerAction(label);
    await action.waitFor({ state: "visible", timeout: 5_000 });
    await action.click();
  }

  async collapseAll(): Promise<void> {
    const action = this.headerAction(/^Collapse All$/);
    await action.waitFor({ state: "visible", timeout: 5_000 });
    if (await action.isEnabled()) await action.click();
    await expect
      .poll(() => this.page.locator('[role="treeitem"][aria-expanded="true"]:visible').count(), {
        timeout: 5_000,
        message: "The Workbench TreeView must be fully collapsed before the scenario starts",
      })
      .toBe(0);
  }

  async expand(label: RegExp): Promise<void> {
    const item = this.item(label);
    await item.waitFor({ state: "visible", timeout: 5_000 });
    await item.scrollIntoViewIfNeeded();
    if ((await item.getAttribute("aria-expanded")) === "true") return;
    await item.locator(".monaco-tl-twistie").click();
    await expect(item).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }

  async collapse(label: RegExp): Promise<void> {
    const item = this.item(label);
    await item.waitFor({ state: "visible", timeout: 5_000 });
    await item.scrollIntoViewIfNeeded();
    if ((await item.getAttribute("aria-expanded")) !== "true") return;
    await item.locator(".monaco-tl-twistie").click();
    await expect(item).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });
  }

  async expandPath(labels: RegExp[]): Promise<void> {
    for (const label of labels) await this.expand(label);
  }

  async select(label: RegExp): Promise<void> {
    const item = this.item(label);
    await item.waitFor({ state: "visible", timeout: 5_000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  }
}
