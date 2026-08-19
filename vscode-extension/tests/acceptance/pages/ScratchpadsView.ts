import { expect, type Locator } from "@playwright/test";
import { escapeRegExp } from "../fixtures/text.js";
import { currentPage, type PageProvider } from "./PageProvider";
import type { QuickInput } from "./QuickInput";
import { WorkbenchTree } from "./WorkbenchTree";

export type ScratchpadTransactionStatus = "in progress" | "failed";

export class ScratchpadsView {
  private readonly tree: WorkbenchTree;

  constructor(
    private readonly pageProvider: PageProvider,
    private readonly quickInput: QuickInput,
  ) {
    this.tree = new WorkbenchTree(pageProvider, "Scratchpads");
  }

  private get page() {
    return currentPage(this.pageProvider);
  }

  locator(): Locator {
    return this.tree.locator();
  }

  async active(): Promise<Locator> {
    const tab = this.page
      .locator(".editor-group-container.active")
      .getByRole("tab", { name: /\.pgsql-notebook$/u })
      .and(this.page.locator('[aria-selected="true"]'))
      .first();
    await expect(tab).toBeVisible({ timeout: 5_000 });
    const tabName = (await tab.getAttribute("aria-label")) ?? (await tab.innerText());
    const scratchpadName = tabName.replace(/\.pgsql-notebook$/u, "");
    const escapedName = escapeRegExp(scratchpadName);
    const scratchpad = await this.tree.findItem(new RegExp(`^${escapedName}`, "u"));
    await expect(scratchpad).toBeVisible({ timeout: 5_000 });
    return scratchpad;
  }

  async transaction(scratchpad: Locator, status: ScratchpadTransactionStatus): Promise<Locator> {
    await this.expand(scratchpad);
    return this.tree.findChild(scratchpad, new RegExp(`^Transaction ${status}`, "u"));
  }

  async hasTransaction(
    scratchpad: Locator,
    status?: ScratchpadTransactionStatus,
  ): Promise<boolean> {
    await this.expand(scratchpad);
    return this.tree.hasChild(
      scratchpad,
      status ? new RegExp(`^Transaction ${status}`, "u") : /^Transaction /u,
    );
  }

  async expectNoTransaction(
    scratchpad: Locator,
    status?: ScratchpadTransactionStatus,
  ): Promise<void> {
    await this.expand(scratchpad);
    await this.tree.expectChildAbsent(
      scratchpad,
      status ? new RegExp(`^Transaction ${status}`, "u") : /^Transaction /u,
    );
  }

  async expectOnlyMatching(label: RegExp, timeout = 5_000): Promise<void> {
    await expect
      .poll(
        async () => {
          const scratchpads = await this.tree.topLevelItemTexts();
          return (
            scratchpads.length > 0 &&
            scratchpads.every((scratchpad) => {
              label.lastIndex = 0;
              return label.test(scratchpad);
            })
          );
        },
        {
          timeout,
          message: `Every filtered Scratchpad row must match ${label}`,
        },
      )
      .toBe(true);
  }

  async requestMode(scratchpad: Locator, mode: "AUTO" | "MANUAL"): Promise<void> {
    const current = await this.tree.waitForStableItem(scratchpad, "Scratchpad");
    await this.hover(current);
    await current.getByLabel(`Mode ${mode}`, { exact: true }).click();
  }

  async setMode(scratchpad: Locator, mode: "AUTO" | "MANUAL"): Promise<Locator> {
    await this.requestMode(scratchpad, mode);
    const current = await this.active();
    await expect(current).toContainText(new RegExp(mode, "u"), { timeout: 5_000 });
    return current;
  }

  async commit(scratchpad: Locator): Promise<void> {
    const transaction = await this.transaction(scratchpad, "in progress");
    const current = await this.tree.waitForStableItem(transaction, "Transaction in progress");
    await this.hover(current, /^Transaction in progress/u);
    await current.getByLabel("Commit", { exact: true }).click();
    await this.expectNoTransaction(await this.active(), "in progress");
  }

  async rollback(scratchpad: Locator): Promise<void> {
    const transaction = await this.transaction(scratchpad, "failed");
    const current = await this.tree.waitForStableItem(transaction, "Transaction failed");
    await expect(current.getByLabel("Commit", { exact: true })).toHaveCount(0);
    await this.hover(current, /^Transaction failed/u);
    await current.getByLabel("Rollback", { exact: true }).click();
    await this.expectNoTransaction(await this.active(), "failed");
  }

  async expand(scratchpad: Locator): Promise<void> {
    await this.tree.expandItem(scratchpad, /^Scratchpad /u);
  }

  async hover(item: Locator, description: RegExp | string = /^Scratchpad /u): Promise<void> {
    await this.tree.hoverItem(item, description);
  }

  headerAction(label: RegExp): Locator {
    return this.tree.headerAction(label);
  }

  async revealHeaderActions(): Promise<void> {
    await this.tree.revealHeaderActions();
  }

  async create(): Promise<void> {
    await this.tree.clickHeaderAction(/New SQL Scratchpad/i);
  }

  async refresh(): Promise<void> {
    await this.tree.clickHeaderAction(/Refresh SQL Scratchpads/i);
  }

  async collapseAll(): Promise<void> {
    const visible = await this.locator()
      .isVisible()
      .catch(() => false);
    if (!visible) return;
    await this.tree.collapseAll();
  }

  async filter(query: string): Promise<void> {
    await this.tree.clickHeaderAction(/Filter SQL Scratchpads/i);
    await this.quickInput.submit(query, /Scratchpad name or Connexion.*Filter SQL Scratchpads/i);
  }
}
