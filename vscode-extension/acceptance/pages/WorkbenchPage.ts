import { expect, type Page } from "@playwright/test";
import { QuickInput } from "./QuickInput";
import { WorkbenchTree } from "./WorkbenchTree";

export class WorkbenchPage {
  readonly quickInput: QuickInput;
  readonly tree: WorkbenchTree;

  constructor(readonly page: Page) {
    this.quickInput = new QuickInput(page);
    this.tree = new WorkbenchTree(page);
  }

  async addServer(connectionUrl: string, expectedServer: RegExp): Promise<void> {
    await this.tree.open();
    const addServer = this.tree.item(/^(Add an existing server|Add Server)/);
    await addServer.waitFor({ state: "visible", timeout: 5_000 });
    await addServer.click();
    await this.quickInput.chooseOption(/Add server/i);
    await this.quickInput.submit(connectionUrl, /postgresql:\/\/user:pass@localhost/i);
    await expect(this.tree.item(expectedServer)).toContainText("connected", { timeout: 5_000 });
  }

  async ensureServer(connectionUrl: string, expectedServer: RegExp): Promise<void> {
    await this.tree.open();
    const existing = this.tree.item(expectedServer);
    if (await existing.isVisible()) {
      await expect(existing).toContainText("connected", { timeout: 5_000 });
      return;
    }
    await this.addServer(connectionUrl, expectedServer);
  }

  async ensureActiveDatabaseIndexed(server: RegExp, database: RegExp): Promise<void> {
    await this.tree.open();
    await this.tree.expandPath([server, database]);
    const sources = this.tree.item(/^Sources/);
    if (await sources.getByText("available", { exact: true }).isVisible()) {
      await this.tree.expand(/^Sources/);
      return;
    }
    await expect(sources).toContainText("not-indexed", { timeout: 5_000 });
    await sources.locator(".monaco-tl-contents").click();
    await expect(sources).toContainText(/indexing|available/, { timeout: 5_000 });
    await expect(sources).toContainText("available", { timeout: 30_000 });
    await this.tree.expand(/^Sources/);
  }

  async openCockpit(): Promise<void> {
    await this.tree.open();
    await this.tree.clickHeaderAction(/Open PostgreSQL Cockpit/i);
  }

  async dragTreeItemToEditor(source: import("@playwright/test").Locator): Promise<void> {
    await source.scrollIntoViewIfNeeded();
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
    await this.page.mouse.up();
  }
}
