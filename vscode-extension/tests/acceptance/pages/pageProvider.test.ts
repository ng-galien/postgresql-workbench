import type { Locator, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchTree } from "./WorkbenchTree.js";

describe("acceptance Page providers", () => {
  it("resolves the current VS Code window after the canonical Page changes", () => {
    const firstLocator = {} as Locator;
    const secondLocator = {} as Locator;
    const firstPage = { getByRole: vi.fn(() => firstLocator) } as unknown as Page;
    const secondPage = { getByRole: vi.fn(() => secondLocator) } as unknown as Page;
    let current = firstPage;
    const tree = new WorkbenchTree(() => current);

    expect(tree.locator()).toBe(firstLocator);
    current = secondPage;
    expect(tree.locator()).toBe(secondLocator);
    expect(firstPage.getByRole).toHaveBeenCalledOnce();
    expect(secondPage.getByRole).toHaveBeenCalledOnce();
  });
});
