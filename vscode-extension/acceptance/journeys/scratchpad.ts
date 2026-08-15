import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { NotebookPage } from "../pages/NotebookPage";
import type { WorkbenchPage } from "../pages/WorkbenchPage";

export async function createScratchpad(
  workbench: WorkbenchPage,
  notebook: NotebookPage,
  association: RegExp,
): Promise<Locator> {
  await expect(workbench.scratchpads.locator()).toBeVisible({ timeout: 5_000 });
  await workbench.scratchpads.create();
  await notebook.activateLatestScratchpad();
  await expect(notebook.cells).toHaveCount(1, { timeout: 5_000 });
  await expect(notebook.cell(0)).toContainText(association);
  return workbench.scratchpads.active();
}
