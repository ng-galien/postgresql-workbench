import { expect } from "@playwright/test";
import type { NotebookPage } from "../pages/NotebookPage";
import type { WorkbenchPage } from "../pages/WorkbenchPage";

export async function createScratchpad(
  workbench: WorkbenchPage,
  notebook: NotebookPage,
  server: RegExp,
  _database: RegExp,
): Promise<void> {
  const scratchpads = workbench.tree.item(/^Scratchpads/);
  await expect(scratchpads).toBeVisible({ timeout: 5_000 });
  await scratchpads.hover();
  await scratchpads.getByLabel(/New SQL Scratchpad/i).click();
  await notebook.activateLatestScratchpad();
  await expect(notebook.cells).toHaveCount(1, { timeout: 5_000 });
  await expect(notebook.cell(0)).toContainText(server);
}
