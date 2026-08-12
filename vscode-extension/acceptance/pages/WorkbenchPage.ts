import { expect, type Page } from "@playwright/test";
import { installDragProbe, readDragProbe } from "../support/dragProbe";
import { QuickInput } from "./QuickInput";
import { WorkbenchTree } from "./WorkbenchTree";

export class WorkbenchPage {
  readonly quickInput: QuickInput;
  readonly tree: WorkbenchTree;

  constructor(
    readonly page: Page,
    private readonly resizeNativeWindow: (width: number, height: number) => Promise<void>,
    private readonly resetNativeWorkbench: () => Promise<void>,
  ) {
    this.quickInput = new QuickInput(page);
    this.tree = new WorkbenchTree(page);
  }

  async resizeWindow(width: number, height: number): Promise<void> {
    await this.resizeNativeWindow(width, height);
  }

  async reset(): Promise<void> {
    await this.resetNativeWorkbench();
    await expect(
      this.page.locator(".editor-group-container .tabs-container .tab:visible"),
    ).toHaveCount(0, { timeout: 5_000 });
    await this.resizeWindow(1_440, 900);
    await this.tree.collapseAll();
  }

  async addServer(connectionUrl: string, expectedServer: RegExp): Promise<void> {
    const addServer = this.tree.item(/^(Add an existing server|Add Server)/);
    await addServer.waitFor({ state: "visible", timeout: 5_000 });
    await addServer.click();
    await this.quickInput.chooseOption(/Add server/i);
    await this.quickInput.submit(connectionUrl, /postgresql:\/\/user:pass@localhost/i);
    await expect(this.tree.item(expectedServer)).toContainText("connected", { timeout: 5_000 });
  }

  async ensureServer(connectionUrl: string, expectedServer: RegExp): Promise<void> {
    const existing = this.tree.item(expectedServer);
    if (await existing.isVisible()) {
      if (!(await existing.innerText()).includes("connected")) {
        await existing.hover();
        const connect = this.page.getByRole("button", { name: "Connect", exact: true });
        await expect(connect).toBeVisible({ timeout: 5_000 });
        await connect.click();
        const password = new URL(connectionUrl).password;
        const passwordPrompt = this.quickInput.input;
        const passwordRequested = await passwordPrompt
          .waitFor({ state: "visible", timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
        if (password && passwordRequested) {
          await this.quickInput.submitSecret(password, /Password for /i);
        }
      }
      await expect(existing).toContainText("connected", { timeout: 5_000 });
      return;
    }
    await this.addServer(connectionUrl, expectedServer);
  }

  async ensureActiveDatabaseIndexed(server: RegExp, database: RegExp): Promise<void> {
    await this.tree.expandPath([server, database]);
    const sources = this.tree.item(/^Sources/);
    await expect(sources).toContainText(/not-indexed|indexing|available|stale|error/, {
      timeout: 5_000,
    });
    const state = await sources.innerText();
    if (!state.includes("available")) {
      if (!state.includes("indexing")) await sources.click();
      await expect(sources).toContainText(/indexing|available/, { timeout: 5_000 });
      await expect(sources).toContainText("available", { timeout: 30_000 });
    }
    await this.tree.expand(/^Sources/);
  }

  async expectActiveDatabaseIndexed(server: RegExp, database: RegExp): Promise<void> {
    await this.tree.expandPath([server, database]);
    const sources = this.tree.item(/^Sources/);
    await expect(sources).toContainText("available", {
      timeout: 5_000,
    });
    await this.tree.expand(/^Sources/);
  }

  async openRoutineSource(
    server: RegExp,
    database: RegExp,
    schema: RegExp,
    routine: RegExp,
  ): Promise<void> {
    await this.openIndexedDefinition(server, database, schema, routine);
  }

  async openIndexedDefinition(
    server: RegExp,
    database: RegExp,
    schema: RegExp,
    object: RegExp,
  ): Promise<void> {
    await this.tree.scrollToTop();
    await this.expectActiveDatabaseIndexed(server, database);
    await this.tree.expandPath([server, database, /^Sources/, schema]);
    const item = await this.tree.findItem(object);
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await item.hover();
    // Use the extension-owned command title exposed by VS Code's accessibility
    // tree. It stays stable across VS Code locales and DOM layout changes.
    const openSource = this.page.getByRole("button", { name: "Open PostgreSQL Definition" });
    await expect(openSource).toBeVisible({ timeout: 5_000 });
    await openSource.click();
  }

  async debugRoutineFromTree(
    server: RegExp,
    database: RegExp,
    schema: RegExp,
    routine: RegExp,
  ): Promise<void> {
    await this.tree.scrollToTop();
    await this.expectActiveDatabaseIndexed(server, database);
    await this.tree.expandPath([server, database, /^Sources/, schema]);
    const item = await this.tree.findItem(routine);
    await item.scrollIntoViewIfNeeded();
    await item.hover();
    const debug = this.page.getByRole("button", { name: "Debug", exact: true });
    await expect(debug).toBeVisible({ timeout: 5_000 });
    await debug.click();
  }

  async openCockpit(): Promise<void> {
    await this.tree.clickHeaderAction(/Open PostgreSQL Cockpit/i);
  }

  async enableAndProvisionSchemaSync(): Promise<void> {
    const schemaSync = this.tree.item(/^Schema synchronization/);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });
    await schemaSync.click();
    await this.quickInput.chooseOption(/Enable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("provisioning required", { timeout: 5_000 });

    await schemaSync.hover();
    await schemaSync.getByLabel(/Provision Schema Synchronization/i).click();
    const provision = this.page.getByRole("button", { name: "Provision", exact: true });
    await expect(provision).toBeVisible({ timeout: 5_000 });
    await provision.click();
    await expect(schemaSync).toContainText("active · listening", { timeout: 10_000 });
  }

  async restartSchemaSync(): Promise<void> {
    const schemaSync = this.tree.item(/^Schema synchronization/);
    await schemaSync.click();
    await this.quickInput.chooseOption(/Disable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });

    await schemaSync.click();
    await this.quickInput.chooseOption(/Enable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("active · listening", { timeout: 10_000 });
  }

  async removeAndDisableSchemaSync(): Promise<void> {
    const schemaSync = this.tree.item(/^Schema synchronization/);
    await schemaSync.click();
    await this.quickInput.chooseOption(/Remove database provisioning/i);
    const remove = this.page.getByRole("button", { name: "Remove Provisioning", exact: true });
    await expect(remove).toBeVisible({ timeout: 5_000 });
    await remove.click();
    await expect(schemaSync).toContainText("provisioning required", { timeout: 10_000 });
    await schemaSync.click();
    await this.quickInput.chooseOption(/Disable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });
  }

  async dragTreeItemToEditor(source: import("@playwright/test").Locator): Promise<void> {
    await source.scrollIntoViewIfNeeded();
    await installDragProbe(this.page);
    const target = this.page.locator(".editor-group-container").first();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox, "The TreeView source must have screen coordinates").not.toBeNull();
    expect(targetBox, "The VS Code editor area must have screen coordinates").not.toBeNull();
    await this.page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await this.page.mouse.down();
    await this.page.mouse.move(sourceBox!.x + sourceBox!.width / 2 + 12, sourceBox!.y + 4, {
      steps: 4,
    });
    await this.page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2,
      { steps: 24 },
    );
    try {
      await expect
        .poll(
          async () =>
            (await readDragProbe(this.page)).some(
              (event) =>
                (event.type === "dragenter" || event.type === "dragover") &&
                event.types.includes("resourceurls"),
            ),
          {
            message: "VS Code must expose an accepted editor drop target before release",
            timeout: 5_000,
          },
        )
        .toBe(true);
    } catch (cause) {
      const events = (await readDragProbe(this.page)).slice(-40);
      throw new Error(
        `The editor did not become ready for the graph drop. sourceBox=${JSON.stringify(sourceBox)}; targetBox=${JSON.stringify(targetBox)}; events=${JSON.stringify(events)}.`,
        { cause },
      );
    } finally {
      await this.page.mouse.up();
    }
    await expect
      .poll(async () => (await readDragProbe(this.page)).some((event) => event.type === "drop"), {
        message: "VS Code must emit the accepted editor drop",
        timeout: 5_000,
      })
      .toBe(true);
  }
}
