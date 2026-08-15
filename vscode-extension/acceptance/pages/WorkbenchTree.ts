import { expect, type Locator } from "@playwright/test";
import { currentPage, type PageProvider } from "./PageProvider";

class TreeChildNotFoundError extends Error {}
class TreeItemNotFoundError extends Error {}

interface VisibleTreeRow {
  expanded: boolean;
  index: number;
  level: number;
  text: string;
}

export class WorkbenchTree {
  constructor(
    private readonly pageProvider: PageProvider,
    private readonly accessibleName = "Workbench",
  ) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  locator(): Locator {
    return this.page.getByRole("tree", { name: this.accessibleName });
  }

  item(label: RegExp): Locator {
    return this.items(label).first();
  }

  items(label: RegExp): Locator {
    return this.locator()
      .locator('.monaco-list-rows > .monaco-list-row[role="treeitem"]')
      .filter({ hasText: label });
  }

  itemByAccessibleName(label: RegExp): Locator {
    return this.locator()
      .getByRole("treeitem", { name: label })
      .and(this.locator().locator(".monaco-list-rows > .monaco-list-row"))
      .first();
  }

  private header(): Locator {
    return this.page
      .locator(".pane-header")
      .filter({ hasText: new RegExp(`^${this.accessibleName}$`, "iu") })
      .first();
  }

  headerAction(label: RegExp): Locator {
    return this.header().getByLabel(label).filter({ visible: true }).first();
  }

  async revealHeaderActions(): Promise<void> {
    await this.header().hover();
  }

  async clickHeaderAction(label: RegExp): Promise<void> {
    await this.revealHeaderActions();
    const action = this.headerAction(label);
    await action.waitFor({ state: "visible", timeout: 5_000 });
    await action.click();
  }

  async collapseAll(): Promise<void> {
    await this.locator().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await this.revealHeaderActions();
    const action = this.headerAction(/^Collapse All$/);
    // The command owns the complete tree model, unlike rendered rows. Invoke it
    // whenever VS Code exposes it so expanded branches outside the virtualized
    // viewport are collapsed as well.
    if ((await action.count()) > 0 && (await action.isEnabled())) await action.click();
    if (await this.hasExpandedItem()) {
      await this.revealHeaderActions();
      await action.waitFor({ state: "visible", timeout: 2_000 });
      await expect(action).toBeEnabled({ timeout: 2_000 });
      await action.click();
    }
    await expect
      .poll(() => this.hasExpandedItem(), {
        timeout: 5_000,
        message: `The ${this.accessibleName} TreeView must be fully collapsed before the scenario starts`,
      })
      .toBe(false);
  }

  async expand(label: RegExp): Promise<void> {
    const item = await this.findItem(label);
    await this.expandItem(item, label);
  }

  async expandItem(item: Locator, label: RegExp): Promise<void> {
    if ((await item.getAttribute("aria-expanded")) === "true") return;
    const twistie = await this.revealTwistie(item, label);
    await twistie.click({ timeout: 2_000 });
    await expect(item).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }

  async collapse(label: RegExp): Promise<void> {
    const item = await this.findItem(label);
    await this.collapseItem(item, label);
  }

  async collapseItem(item: Locator, label: RegExp): Promise<void> {
    if ((await item.getAttribute("aria-expanded")) !== "true") return;
    const twistie = await this.revealTwistie(item, label);
    await twistie.click({ timeout: 2_000 });
    await expect(item).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });
  }

  private async revealTwistie(item: Locator, label: RegExp): Promise<Locator> {
    // A short native TreeView can place several sticky ancestor rows over the
    // real row. Move the list in bounded increments until the real twistie owns
    // its screen coordinates; this preserves VS Code's normal click semantics.
    const twistie = item.locator(".monaco-tl-twistie");
    await this.locator().hover();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const actionable = await twistie
        .evaluate((element: HTMLElement) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit === element || (hit !== null && element.contains(hit));
        })
        .catch(() => false);
      if (actionable) return twistie;
      await this.page.mouse.wheel(0, -40);
      await this.page.waitForTimeout(50);
    }
    throw new Error(`The ${label} TreeView twistie remains covered by sticky rows`);
  }

  async expandPath(labels: RegExp[]): Promise<Locator> {
    if (labels.length === 0) throw new Error("A TreeView path must contain at least one item");
    let item = await this.findItem(labels[0]);
    await this.expandItem(item, labels[0]);
    for (const label of labels.slice(1)) {
      item = await this.findChild(item, label);
      await this.expandItem(item, label);
    }
    return item;
  }

  async scrollToTop(): Promise<void> {
    const tree = this.locator();
    const scrollable = tree.locator(".monaco-scrollable-element:has(.monaco-list-rows)").first();
    const bounds = await scrollable.boundingBox();
    expect(
      bounds,
      `The ${this.accessibleName} TreeView must expose its scroll viewport`,
    ).not.toBeNull();
    await this.page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height - 8);
    const rows = tree.locator('.monaco-list-rows > .monaco-list-row[role="treeitem"]');
    if ((await rows.count()) === 0) return;
    const firstRow = tree.locator(
      '.monaco-list-rows > .monaco-list-row[role="treeitem"][data-index="0"]',
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await firstRow.isVisible()) return;
      await this.page.mouse.wheel(0, -500);
      await this.page.waitForTimeout(25);
    }
    throw new Error(`The ${this.accessibleName} TreeView did not return to its first row`);
  }

  async findItem(label: RegExp): Promise<Locator> {
    const index = await this.scanRows((rows) => {
      const match = rows.find(({ text }) => {
        label.lastIndex = 0;
        return label.test(text);
      });
      return match?.index;
    });
    if (index !== undefined) {
      const item = this.locator()
        .locator(`.monaco-list-rows > .monaco-list-row[role="treeitem"][data-index="${index}"]`)
        .filter({ hasText: label });
      await item.waitFor({ state: "visible", timeout: 2_000 });
      return item;
    }
    throw new TreeItemNotFoundError(
      `The ${this.accessibleName} TreeView does not contain ${label}`,
    );
  }

  async hasItem(label: RegExp): Promise<boolean> {
    try {
      await this.findItem(label);
      return true;
    } catch (error) {
      if (error instanceof TreeItemNotFoundError) return false;
      throw error;
    }
  }

  async waitForItem(label: RegExp, timeout = 5_000): Promise<Locator> {
    await expect
      .poll(() => this.hasItem(label), {
        timeout,
        message: `The ${this.accessibleName} TreeView must eventually contain ${label}`,
      })
      .toBe(true);
    return this.findItem(label);
  }

  async expectItemAbsent(label: RegExp, timeout = 5_000): Promise<void> {
    await expect
      .poll(() => this.hasItem(label), {
        timeout,
        message: `The ${this.accessibleName} TreeView must not contain ${label}`,
      })
      .toBe(false);
  }

  async itemTexts(label: RegExp): Promise<string[]> {
    const matches = new Map<number, string>();
    await this.scanRows((rows) => {
      for (const row of rows) {
        label.lastIndex = 0;
        if (label.test(row.text)) matches.set(row.index, row.text);
      }
      return undefined;
    });
    return [...matches.entries()].sort(([left], [right]) => left - right).map(([, text]) => text);
  }

  async topLevelItemTexts(): Promise<string[]> {
    const matches = new Map<number, string>();
    await this.scanRows((rows) => {
      for (const row of rows) {
        if (row.level === 1) matches.set(row.index, row.text);
      }
      return undefined;
    });
    return [...matches.entries()].sort(([left], [right]) => left - right).map(([, text]) => text);
  }

  async findChild(parent: Locator, label: RegExp): Promise<Locator> {
    await parent.scrollIntoViewIfNeeded();
    await this.revealItem(parent, label);
    const [parentIndexValue, parentLevelValue] = await Promise.all([
      parent.getAttribute("data-index"),
      parent.getAttribute("aria-level"),
    ]);
    const parentIndex = Number(parentIndexValue);
    const parentLevel = Number(parentLevelValue);
    if (!Number.isInteger(parentIndex) || !Number.isInteger(parentLevel)) {
      throw new Error(`The parent of ${label} has no stable TreeView position`);
    }

    const rows = this.locator().locator('.monaco-list-rows > .monaco-list-row[role="treeitem"]');
    await this.locator().hover();
    const seen = new Map<number, { level: number; text: string }>();
    const scrollStep = await this.scrollStep();
    let previousMaximum = parentIndex;
    let stalledAttempts = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const scan = await rows.evaluateAll(
        (elements, expected) => {
          const expression = new RegExp(expected.source, expected.flags);
          let boundary: number | undefined;
          let match: number | undefined;
          let maximum = expected.parentIndex;
          const visible: Array<{ index: number; level: number; text: string }> = [];
          for (const element of elements as HTMLElement[]) {
            const index = Number(element.dataset.index);
            const level = Number(element.getAttribute("aria-level"));
            if (!Number.isInteger(index) || !Number.isInteger(level)) continue;
            visible.push({ index, level, text: element.innerText });
            maximum = Math.max(maximum, index);
            if (index <= expected.parentIndex) continue;
            if (level <= expected.parentLevel) {
              boundary = boundary === undefined ? index : Math.min(boundary, index);
              continue;
            }
            if (match === undefined && level === expected.parentLevel + 1) {
              expression.lastIndex = 0;
              if (expression.test(element.innerText)) match = index;
            }
          }
          if (match !== undefined && (boundary === undefined || match < boundary)) {
            return { boundary, match, maximum, visible };
          }
          return { boundary, maximum, visible };
        },
        {
          flags: label.flags,
          parentIndex,
          parentLevel,
          source: label.source,
        },
      );
      for (const row of scan.visible) seen.set(row.index, { level: row.level, text: row.text });
      if (scan.match !== undefined) {
        const child = this.locator()
          .locator(
            `.monaco-list-rows > .monaco-list-row[role="treeitem"][data-index="${scan.match}"]`,
          )
          .filter({ hasText: label });
        await child.waitFor({ state: "visible", timeout: 2_000 });
        return child;
      }
      if (scan.boundary !== undefined) {
        throw new TreeChildNotFoundError(
          `The ${label} item is not a child of the selected TreeView branch: ${JSON.stringify([...seen.entries()])}`,
        );
      }
      if (await this.isAtBottom()) {
        throw new TreeChildNotFoundError(
          `The ${this.accessibleName} TreeView does not contain child ${label}: ${JSON.stringify([...seen.entries()])}`,
        );
      }
      stalledAttempts = scan.maximum > previousMaximum ? 0 : stalledAttempts + 1;
      if (stalledAttempts >= 3) {
        throw new Error(
          `The ${this.accessibleName} TreeView stopped scrolling before resolving child ${label}: ${JSON.stringify([...seen.entries()])}`,
        );
      }
      await this.page.mouse.wheel(0, scrollStep);
      previousMaximum = Math.max(previousMaximum, scan.maximum);
      await this.page.waitForTimeout(50);
    }
    throw new TreeChildNotFoundError(
      `The ${this.accessibleName} TreeView did not reveal child ${label}`,
    );
  }

  async hasChild(parent: Locator, label: RegExp): Promise<boolean> {
    try {
      await this.findChild(parent, label);
      return true;
    } catch (error) {
      if (error instanceof TreeChildNotFoundError) return false;
      throw error;
    }
  }

  async expectChildAbsent(parent: Locator, label: RegExp, timeout = 5_000): Promise<void> {
    await expect
      .poll(() => this.hasChild(parent, label), {
        timeout,
        message: `The ${this.accessibleName} TreeView branch must not contain ${label}`,
      })
      .toBe(false);
  }

  async revealItem(row: Locator, description: RegExp | string): Promise<void> {
    await this.locator().hover();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const actionable = await row
        .evaluate((element: HTMLElement) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit === element || (hit !== null && element.contains(hit));
        })
        .catch(() => false);
      if (actionable) return;
      await this.page.mouse.wheel(0, -40);
      await this.page.waitForTimeout(50);
    }
    throw new Error(`The ${description} row remains covered by sticky rows`);
  }

  async hoverItem(row: Locator, description: RegExp | string): Promise<void> {
    await row.scrollIntoViewIfNeeded();
    await this.revealItem(row, description);
    await row.hover({ timeout: 2_000 });
  }

  async waitForStableItem(row: Locator, description: RegExp | string): Promise<Locator> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await row.waitFor({ state: "visible", timeout: 2_000 });
      const marker = `pgwb-${Date.now()}-${attempt}`;
      await row.evaluate((element, value) => {
        element.setAttribute("data-pgwb-acceptance-stability", value);
      }, marker);
      await this.page.waitForTimeout(75);
      const unchanged = await row
        .evaluate(
          (element, value) => element.getAttribute("data-pgwb-acceptance-stability") === value,
          marker,
        )
        .catch(() => false);
      if (unchanged) {
        await row.evaluate((element) => {
          element.removeAttribute("data-pgwb-acceptance-stability");
        });
        return row;
      }
    }
    throw new Error(`The ${description} TreeView row kept being re-projected for 1500 ms`);
  }

  async select(label: RegExp): Promise<void> {
    const item = await this.findItem(label);
    await item.click();
  }

  private async hasExpandedItem(): Promise<boolean> {
    return (
      (await this.scanRows((rows) => (rows.some(({ expanded }) => expanded) ? true : undefined))) ??
      false
    );
  }

  private async scanRows<T>(
    resolve: (rows: VisibleTreeRow[]) => T | undefined,
  ): Promise<T | undefined> {
    await this.scrollToTop();
    const rows = this.locator().locator('.monaco-list-rows > .monaco-list-row[role="treeitem"]');
    if ((await rows.count()) === 0) return undefined;

    await this.locator().hover();
    const scrollStep = await this.scrollStep();
    let previousMaximum = -1;
    let stalledAttempts = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const visible = await rows.evaluateAll((elements) =>
        (elements as HTMLElement[])
          .map((element) => ({
            expanded: element.getAttribute("aria-expanded") === "true",
            index: Number(element.dataset.index),
            level: Number(element.getAttribute("aria-level")),
            text: element.innerText,
          }))
          .filter(({ index, level }) => Number.isInteger(index) && Number.isInteger(level)),
      );
      const result = resolve(visible);
      if (result !== undefined) return result;
      if (await this.isAtBottom()) return undefined;

      const maximum = Math.max(previousMaximum, ...visible.map(({ index }) => index));
      stalledAttempts = maximum > previousMaximum ? 0 : stalledAttempts + 1;
      if (stalledAttempts >= 3) {
        throw new Error(
          `The ${this.accessibleName} TreeView stopped scrolling before its final row`,
        );
      }
      previousMaximum = maximum;
      await this.page.mouse.wheel(0, scrollStep);
      await this.page.waitForTimeout(50);
    }
    throw new Error(`The ${this.accessibleName} TreeView exceeded its bounded full-tree scan`);
  }

  private async scrollStep(): Promise<number> {
    const bounds = await this.locator().boundingBox();
    expect(bounds, `The ${this.accessibleName} TreeView must expose its viewport`).not.toBeNull();
    return Math.max(40, Math.min(250, Math.floor(bounds!.height * 0.6)));
  }

  private async isAtBottom(): Promise<boolean> {
    const scrollable = this.locator()
      .locator(".monaco-scrollable-element:has(.monaco-list-rows)")
      .first();
    return scrollable.evaluate(
      (element: HTMLElement) =>
        element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
  }
}
