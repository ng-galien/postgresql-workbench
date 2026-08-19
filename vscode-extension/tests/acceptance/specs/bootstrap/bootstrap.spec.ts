import { expect, test } from "../../fixtures/bootstrapTest";

test("starts VS Code, activates PostgreSQL Workbench, and opens its view", async ({ vscode }) => {
  await expect(vscode.page.getByLabel("PostgreSQL Workbench", { exact: true }).first()).toBeVisible(
    {
      timeout: 5_000,
    },
  );
});
