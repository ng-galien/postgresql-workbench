import { expect, type Locator, type Page } from "@playwright/test";

class TreeChildNotFoundError extends Error {}

export class WorkbenchTree {
  constructor(
    private readonly page: Page,
    private readonly accessibleName = "Workbench",
  ) {}

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
    const action = this.headerAction(/^Collapse All$/);
    if (
      (await this.locator()
        .locator('.monaco-list-rows > [role="treeitem"][aria-expanded="true"]:visible')
        .count()) > 0
    ) {
      await action.waitFor({ state: "visible", timeout: 5_000 });
      if (await action.isEnabled()) await action.click();
    }
    await expect
      .poll(
        () =>
          this.locator()
            .locator('.monaco-list-rows > [role="treeitem"][aria-expanded="true"]:visible')
            .count(),
        {
          timeout: 5_000,
          message: "The Workbench TreeView must be fully collapsed before the scenario starts",
        },
      )
      .toBe(0);
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
    const item = this.item(label);
    await this.scrollToTop();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await item.isVisible()) return item;
      await this.page.mouse.wheel(0, 500);
      await this.page.waitForTimeout(50);
    }
    throw new Error(`The ${this.accessibleName} TreeView did not reveal ${label} after scrolling`);
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
    let previousMaximum = parentIndex;
    for (let attempt = 0; attempt < 40; attempt += 1) {
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
            if (
              match === undefined &&
              level === expected.parentLevel + 1 &&
              expression.test(element.innerText)
            ) {
              match = index;
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
          `The ${label} item is not a child of the selected TreeView branch: ${JSON.stringify(scan.visible)}`,
        );
      }
      await this.page.mouse.wheel(0, scan.maximum > previousMaximum ? 250 : 500);
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

  async select(label: RegExp): Promise<void> {
    const item = await this.findItem(label);
    await item.click();
  }
}
