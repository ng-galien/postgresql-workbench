import { expect, type Page } from "@playwright/test";
import { readDragProbe, startNativeTreeDrag } from "../support/dragProbe";
import { QuickInput } from "./QuickInput";
import { ScratchpadsView } from "./ScratchpadsView";
import { WorkbenchTree } from "./WorkbenchTree";

export class WorkbenchPage {
  readonly quickInput: QuickInput;
  readonly tree: WorkbenchTree;
  readonly scratchpads: ScratchpadsView;

  constructor(
    readonly page: Page,
    private readonly resizeNativeWindow: (width: number, height: number) => Promise<void>,
    private readonly resetNativeWorkbench: () => Promise<void>,
  ) {
    this.quickInput = new QuickInput(page);
    this.tree = new WorkbenchTree(page);
    this.scratchpads = new ScratchpadsView(page, this.quickInput);
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
    const addServer = await this.tree.findItem(/^(Add an existing server|Add Server)/);
    await addServer.click();
    await this.quickInput.chooseOption(/Add server/i);
    await this.quickInput.submit(connectionUrl, /postgresql:\/\/user:pass@localhost/i);
    await expect(await this.tree.findItem(expectedServer)).toContainText("connected", {
      timeout: 5_000,
    });
  }

  async ensureServer(connectionUrl: string, expectedServer: RegExp): Promise<void> {
    const existing = await this.tree.findItem(expectedServer).catch(() => undefined);
    if (existing !== undefined) {
      if (!(await existing.innerText()).includes("connected")) {
        await this.tree.hoverItem(existing, expectedServer);
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
    let databaseContext = await this.tree.expandPath([server, database]);
    let sources = await this.tree.findChild(databaseContext, /^Sources/);
    if ((await sources.innerText()).includes("inactive")) {
      await databaseContext.click();
      databaseContext = await this.tree.expandPath([server, database]);
      sources = await this.tree.findChild(databaseContext, /^Sources/);
      await expect(sources).not.toContainText("inactive", { timeout: 5_000 });
    }
    const state = await this.expectSourcesState(
      sources,
      /^(?:not indexed|indexing|refreshing|available|stale|cancelled|failed)$/u,
      5_000,
    );
    if (state !== "available") {
      if (state !== "indexing" && state !== "refreshing") await sources.click();
      await this.expectSourcesState(sources, /^(?:indexing|refreshing|available)$/u, 5_000);
      await this.expectSourcesState(sources, /^available$/u, 30_000);
    }
    await this.tree.expandItem(sources, /^Sources/);
  }

  async expectActiveDatabaseIndexed(server: RegExp, database: RegExp): Promise<void> {
    let databaseContext = await this.tree.expandPath([server, database]);
    let sources = await this.tree.findChild(databaseContext, /^Sources/);
    if ((await sources.innerText()).includes("inactive")) {
      await databaseContext.click();
      databaseContext = await this.tree.expandPath([server, database]);
      sources = await this.tree.findChild(databaseContext, /^Sources/);
    }
    await this.expectSourcesState(sources, /^(?:indexing|refreshing|available)$/u, 5_000);
    await this.expectSourcesState(sources, /^available$/u, 30_000);
    await this.tree.expandItem(sources, /^Sources/);
  }

  private async expectSourcesState(
    sources: import("@playwright/test").Locator,
    expected: RegExp,
    timeout: number,
  ): Promise<string> {
    let observed = "missing";
    await expect
      .poll(
        async () => {
          const accessibleName = (await sources.getAttribute("aria-label")) ?? "";
          observed = /^Sources, [^,]+, ([^,]+)/u.exec(accessibleName)?.[1] ?? "missing";
          return observed;
        },
        {
          timeout,
          message: `The exact Sources row must reach state ${expected}`,
        },
      )
      .toMatch(expected);
    return observed;
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
    const schemaItem = await this.tree.expandPath([server, database, /^Sources/, schema]);
    const item = await this.tree.findChild(schemaItem, object);
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await this.tree.hoverItem(item, object);
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
    const schemaItem = await this.tree.expandPath([server, database, /^Sources/, schema]);
    const item = await this.tree.findChild(schemaItem, routine);
    await this.tree.hoverItem(item, routine);
    const debug = this.page.getByRole("button", { name: "Debug", exact: true });
    await expect(debug).toBeVisible({ timeout: 5_000 });
    await debug.click();
  }

  async openCockpit(): Promise<void> {
    await this.tree.clickHeaderAction(/Open PostgreSQL Cockpit/i);
  }

  async enableAndProvisionSchemaSync(server: RegExp, database: RegExp): Promise<void> {
    const databaseContext = await this.tree.expandPath([server, database]);
    const schemaSync = await this.tree.findChild(databaseContext, /^Schema synchronization/);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });
    await schemaSync.click();
    await this.quickInput.chooseOption(/Enable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("provisioning required", { timeout: 5_000 });

    await this.tree.hoverItem(schemaSync, /^Schema synchronization/);
    await schemaSync.getByLabel(/Provision Schema Synchronization/i).click();
    const provision = this.page.getByRole("button", { name: "Provision", exact: true });
    await expect(provision).toBeVisible({ timeout: 5_000 });
    await provision.click();
    await expect(schemaSync).toContainText("active · listening", { timeout: 10_000 });
  }

  async restartSchemaSync(server: RegExp, database: RegExp): Promise<void> {
    const databaseContext = await this.tree.expandPath([server, database]);
    const schemaSync = await this.tree.findChild(databaseContext, /^Schema synchronization/);
    await schemaSync.click();
    await this.quickInput.chooseOption(/Disable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });

    await schemaSync.click();
    await this.quickInput.chooseOption(/Enable for this DatabaseContext/i);
    await expect(schemaSync).toContainText("active · listening", { timeout: 10_000 });
  }

  async removeAndDisableSchemaSync(server: RegExp, database: RegExp): Promise<void> {
    const databaseContext = await this.tree.expandPath([server, database]);
    const schemaSync = await this.tree.findChild(databaseContext, /^Schema synchronization/);
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
    const target = this.page.locator(".editor-group-container").first();
    await this.dragTreeItemToTarget(source, target, false);
  }

  async dragTreeItemToTextEditor(
    source: import("@playwright/test").Locator,
    target: import("@playwright/test").Locator,
    atFirstLine = false,
  ): Promise<void> {
    const dropTarget = atFirstLine
      ? target.locator(".view-line").first()
      : target.locator(".view-lines").first();
    await this.dragTreeItemToTarget(source, dropTarget, true, atFirstLine);
  }

  private async dragTreeItemToTarget(
    source: import("@playwright/test").Locator,
    target: import("@playwright/test").Locator,
    dropIntoTextEditor: boolean,
    nearStart = false,
  ): Promise<void> {
    await this.tree.revealItem(source, "drag source");
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    expect(targetBox, "The VS Code editor area must have screen coordinates").not.toBeNull();
    const { sourceBox, failedAttempts } = await startNativeTreeDrag(this.page, source);
    if (dropIntoTextEditor) await this.page.keyboard.down("Shift");
    try {
      const targetX = nearStart
        ? targetBox!.x + Math.min(80, targetBox!.width / 2)
        : targetBox!.x + targetBox!.width / 2;
      const targetY = nearStart
        ? targetBox!.y + Math.min(12, targetBox!.height / 2)
        : targetBox!.y + targetBox!.height / 2;
      await this.page.mouse.move(targetX, targetY, { steps: 24 });
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
          `The editor did not become ready for the graph drop. sourceBox=${JSON.stringify(sourceBox)}; targetBox=${JSON.stringify(targetBox)}; events=${JSON.stringify(events)}; failedStartAttempts=${JSON.stringify(failedAttempts)}.`,
          { cause },
        );
      }
    } finally {
      await this.page.mouse.up();
      if (dropIntoTextEditor) await this.page.keyboard.up("Shift");
    }
    await expect
      .poll(async () => (await readDragProbe(this.page)).some((event) => event.type === "drop"), {
        message: "VS Code must emit the accepted editor drop",
        timeout: 5_000,
      })
      .toBe(true);
  }
}
