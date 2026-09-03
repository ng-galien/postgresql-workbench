import { expect, test } from "../../fixtures/test";

/*
 * The whole life of a Connection on the one page a new user meets first: described and tested,
 * created and connected, its live server read from the Overview, the debugger extension installed
 * from there, then renamed and removed — without a single host input box. template1 keeps the
 * identity unique to this journey, and its missing pldbgapi proves the verdict tells connection
 * and debugger apart.
 */
test.describe("Connections page", () => {
  test("creates, tests, renames and deletes a Connection on the page", async ({
    connectionsPage,
  }) => {
    const url = "postgres@localhost:5434/template1";

    const frame = await test.step("open the Connections page", () => connectionsPage.open());

    await test.step("fill the complete editor viewport", async () => {
      const pageHeight = await frame
        .locator(".connections-page")
        .evaluate((element) => element.getBoundingClientRect().height);
      const viewportHeight = await frame.evaluate(() => window.innerHeight);
      expect(Math.abs(viewportHeight - pageHeight)).toBeLessThanOrEqual(1);
    });

    await test.step("describe a new Connection and test it against the live server", async () => {
      await connectionsPage.startAdding(frame);
      await connectionsPage.fill(frame, {
        Host: "localhost",
        Port: "5434",
        Database: "template1",
        User: "postgres",
        Password: "postgres",
      });
      const report = await connectionsPage.testConnection(frame);
      await expect(report).toContainText("Connected to localhost:5434/template1 as postgres");
      await expect(report).toContainText("PL/pgSQL debugger");
    });

    await test.step("create it, connect it, and land on the live Overview", async () => {
      await frame.getByRole("button", { name: "Create & Connect", exact: true }).click();
      await expect(connectionsPage.listedConnection(frame, url)).toBeVisible({ timeout: 15_000 });
      const overview = frame.getByRole("region", { name: "Server overview" });
      await expect(overview).toContainText(/PostgreSQL \d/u, { timeout: 20_000 });
      await expect(overview).toContainText("Connections");
      const sessions = frame.getByRole("region", { name: "Open sessions" });
      await expect(sessions).toContainText("postgresql-workbench", { timeout: 10_000 });
      const databases = frame.getByRole("region", { name: "Databases" });
      await expect(databases).toContainText("demo");
      await expect(databases).toContainText("template1");
      await expect(databases.getByText("current", { exact: true })).toBeVisible();
    });

    await test.step("install the debugger extension from the Overview", async () => {
      const extensions = frame.getByRole("region", { name: "Extensions" });
      await expect(extensions).toContainText("pldbgapi", { timeout: 10_000 });
      await expect(extensions).toContainText("pgtap");
      const install = extensions.getByRole("button", { name: "Install pldbgapi", exact: true });
      if ((await install.count()) > 0) await install.click();
      await expect(extensions.getByText(/installed \d/u).first()).toBeVisible({
        timeout: 20_000,
      });
    });

    await test.step("rename it from the editor form", async () => {
      await connectionsPage.openSettings(frame, url);
      await connectionsPage.fill(frame, { Name: "Acceptance Page Connection" });
      await frame.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        connectionsPage.listedConnection(frame, "Acceptance Page Connection"),
      ).toBeVisible({ timeout: 5_000 });
    });

    await test.step("delete it after confirming on the page", async () => {
      await connectionsPage.openDangerZone(frame);
      await frame.getByRole("button", { name: "Delete Connection", exact: true }).click();
      await frame.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(connectionsPage.listedConnection(frame, url)).toHaveCount(0, {
        timeout: 10_000,
      });
    });
  });
});
