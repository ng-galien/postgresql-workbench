import { expect, type Locator, type Page } from "@playwright/test";
import type { QuickInput } from "./QuickInput";
import { WorkbenchTree } from "./WorkbenchTree";

export type ScratchpadTransactionStatus = "in progress" | "failed";

export class ScratchpadsView {
  private readonly tree: WorkbenchTree;

  constructor(
    private readonly page: Page,
    private readonly quickInput: QuickInput,
  ) {
    this.tree = new WorkbenchTree(page, "Scratchpads");
  }

  locator(): Locator {
    return this.tree.locator();
  }

  all(): Locator {
    return this.tree.items(/^Scratchpad /u);
  }

  async active(): Promise<Locator> {
    const tab = this.page
      .getByRole("tab", { name: /\.pgsql-notebook$/u })
      .and(this.page.locator('[aria-selected="true"]'))
      .first();
    await expect(tab).toBeVisible({ timeout: 5_000 });
    const tabName = (await tab.getAttribute("aria-label")) ?? (await tab.innerText());
    const scratchpadName = tabName.replace(/\.pgsql-notebook$/u, "");
    const escapedName = scratchpadName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const scratchpad = await this.tree.findItem(new RegExp(`^${escapedName}`, "u"));
    await expect(scratchpad).toBeVisible({ timeout: 5_000 });
    return scratchpad;
  }

  transactions(): Locator {
    return this.tree.items(/^Transaction /u);
  }

  transaction(status: ScratchpadTransactionStatus): Locator {
    return this.tree.item(new RegExp(`^Transaction ${status}`, "u"));
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

  async filter(query: string): Promise<void> {
    await this.tree.clickHeaderAction(/Filter SQL Scratchpads/i);
    await this.quickInput.submit(query, /Scratchpad name or Connexion.*Filter SQL Scratchpads/i);
  }
}
