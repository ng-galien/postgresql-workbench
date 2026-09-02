import { expect, type Locator } from "@playwright/test";
import type { WorkbenchStateSnapshot } from "../fixtures/vscode";
import { readDragProbe, startNativeTreeDrag } from "../support/dragProbe";
import { currentPage, type PageProvider } from "./PageProvider";
import { QuickInput } from "./QuickInput";
import { ScratchpadsView } from "./ScratchpadsView";
import { WorkbenchTree } from "./WorkbenchTree";
import { SCHEMAS_TREE_ITEM } from "./WorkbenchTreeLabels";

// A Connection row reads "connected" or "disconnected"; match the former only.
export const CONNECTED_TEXT = /(?<!dis)connected/u;

export class WorkbenchPage {
  readonly quickInput: QuickInput;
  readonly tree: WorkbenchTree;
  readonly scratchpads: ScratchpadsView;

  constructor(
    private readonly pageProvider: PageProvider,
    private readonly resizeNativeWindow: (width: number, height: number) => Promise<void>,
    private readonly resetNativeWorkbench: () => Promise<void>,
    private readonly inspectWorkbenchState?: () => Promise<WorkbenchStateSnapshot>,
  ) {
    this.quickInput = new QuickInput(pageProvider);
    this.tree = new WorkbenchTree(pageProvider);
    this.scratchpads = new ScratchpadsView(pageProvider, this.quickInput);
  }

  get page() {
    return currentPage(this.pageProvider);
  }

  async resizeWindow(width: number, height: number): Promise<void> {
    await this.resizeNativeWindow(width, height);
  }

  async reset(): Promise<void> {
    await this.resetNativeWorkbench();
    await expect(this.page.locator(".quick-input-widget:visible")).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(
      this.page.locator(".editor-group-container .tabs-container .tab:visible"),
    ).toHaveCount(0, { timeout: 5_000 });
    await this.resizeWindow(1_440, 900);
    await this.tree.collapseAll();
  }

  async addConnection(connectionUrl: string, expectedConnection: RegExp): Promise<void> {
    const addConnection = await this.tree.findItem(/^Add Connection\.\.\.$/);
    await addConnection.click();
    await this.quickInput.chooseThenInput(/Add connection/i, /postgresql:\/\/user:pass@localhost/i);
    await this.quickInput.submit(connectionUrl, /postgresql:\/\/user:pass@localhost/i);
    await expect(await this.tree.waitForItem(expectedConnection)).toContainText(CONNECTED_TEXT, {
      timeout: 5_000,
    });
  }

  async ensureConnection(connectionUrl: string, expectedConnection: RegExp): Promise<void> {
    const existing = await this.tree.findItem(expectedConnection).catch(() => undefined);
    if (existing !== undefined) {
      if (!CONNECTED_TEXT.test(await existing.innerText())) {
        await this.tree.hoverItem(existing, expectedConnection);
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
      await expect(existing).toContainText(CONNECTED_TEXT, { timeout: 5_000 });
      return;
    }
    await this.addConnection(connectionUrl, expectedConnection);
  }

  async ensureDatabaseIndexed(connection: RegExp, database: RegExp): Promise<void> {
    const databaseItem = await this.tree.expandPath([connection, database]);
    const schemas = await this.tree.findChild(databaseItem, SCHEMAS_TREE_ITEM);
    const state = await this.expectSchemasState(
      schemas,
      /^(?:not indexed|indexing|refreshing|available|stale|cancelled|failed)$/u,
      5_000,
    );
    if (state !== "available") {
      if (state !== "indexing" && state !== "refreshing") await schemas.click();
      await this.expectSchemasState(schemas, /^(?:indexing|refreshing|available)$/u, 5_000);
      await this.expectSchemasState(schemas, /^available$/u, 10_000);
    }
    await this.tree.expandItem(schemas, SCHEMAS_TREE_ITEM);
    await this.expectFreshIndexRuntime({ database });
  }

  async expectDatabaseIndexed(connection: RegExp, database: RegExp): Promise<void> {
    const databaseItem = await this.tree.expandPath([connection, database]);
    const schemas = await this.tree.findChild(databaseItem, SCHEMAS_TREE_ITEM);
    await this.expectSchemasState(schemas, /^(?:indexing|refreshing|available)$/u, 5_000);
    await this.expectSchemasState(schemas, /^available$/u, 10_000);
    await this.tree.expandItem(schemas, SCHEMAS_TREE_ITEM);
    await this.expectFreshIndexRuntime({ database });
  }

  async expectFreshIndexRuntime(
    expected: { database?: RegExp; connectionId?: string; settledRunId?: number } = {},
  ): Promise<{
    generation: number;
    revision: string;
    connectionId: string;
  }> {
    if (!this.inspectWorkbenchState) {
      throw new Error("The Workbench runtime inspector is required for index readiness");
    }
    let observed: WorkbenchStateSnapshot | undefined;
    await expect
      .poll(
        async () => {
          observed = await this.inspectWorkbenchState?.();
          const candidates = (observed?.index.states ?? []).filter((state) => {
            const result = state.result;
            if (!result || state.status !== "available") return false;
            if (!observed?.connection.connectedConnectionIds.includes(result.connectionId))
              return false;
            if (expected.connectionId && result.connectionId !== expected.connectionId)
              return false;
            return !expected.database || regexMatches(expected.database, result.database);
          });
          const settledRun = observed?.index.lastSettledRun;
          const connectionId = candidates[0]?.result?.connectionId;
          // Quiescence is judged for this exact Connection: other Connections may
          // keep indexing concurrently without affecting this snapshot.
          const busy =
            observed?.index.activeRuns.some((run) => run.connectionId === connectionId) ||
            observed?.index.pendingRuns.some((run) => run.connectionId === connectionId);
          return Boolean(
            observed?.connection.connected &&
              candidates.length === 1 &&
              typeof candidates[0]?.result?.generation === "number" &&
              (expected.settledRunId === undefined ||
                (settledRun?.id === expected.settledRunId && settledRun.status === "available")) &&
              !busy &&
              observed.index.sourceMutationsActive === 0 &&
              !observed.index.gate,
          );
        },
        {
          timeout: 10_000,
          message: "The exact Connection index must be published and quiescent",
        },
      )
      .toBe(true)
      .catch((error: unknown) => {
        // Say what the index was doing: a wait that only reports its own name explains nothing.
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nindex: ${JSON.stringify(observed?.index)}`,
        );
      });
    const candidates = (observed?.index.states ?? []).filter((state) => {
      const result = state.result;
      if (!result || state.status !== "available") return false;
      if (!observed?.connection.connectedConnectionIds.includes(result.connectionId)) return false;
      if (expected.connectionId && result.connectionId !== expected.connectionId) return false;
      return !expected.database || regexMatches(expected.database, result.database);
    });
    const result = candidates[0]?.result;
    if (!result || candidates.length !== 1 || typeof result.generation !== "number") {
      throw new Error(
        `The fresh index runtime snapshot is incomplete: ${JSON.stringify(observed)}`,
      );
    }
    return {
      generation: result.generation,
      revision: result.revision,
      connectionId: result.connectionId,
    };
  }

  private async expectSchemasState(
    schemas: import("@playwright/test").Locator,
    expected: RegExp,
    timeout: number,
  ): Promise<string> {
    let observed = "missing";
    await expect
      .poll(
        async () => {
          const accessibleName = (await schemas.getAttribute("aria-label")) ?? "";
          observed = /^Schemas, [^,]+, ([^,]+)/u.exec(accessibleName)?.[1] ?? "missing";
          return observed;
        },
        {
          timeout,
          message: `The exact Schemas row must reach state ${expected}`,
        },
      )
      .toMatch(expected);
    return observed;
  }

  async openRoutineSource(
    connection: RegExp,
    database: RegExp,
    schema: RegExp,
    routine: RegExp,
  ): Promise<void> {
    await this.openIndexedDefinition(connection, database, schema, routine);
  }

  async openIndexedDefinition(
    connection: RegExp,
    database: RegExp,
    schema: RegExp,
    object: RegExp,
  ): Promise<void> {
    await this.tree.scrollToTop();
    await this.expectDatabaseIndexed(connection, database);
    const schemaItem = await this.tree.expandPath([
      connection,
      database,
      SCHEMAS_TREE_ITEM,
      schema,
    ]);
    const item = await this.tree.findChild(schemaItem, object);
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await this.tree.hoverItem(item, object);
    // Use the extension-owned command title exposed by VS Code's accessibility
    // tree. It stays stable across VS Code locales and DOM layout changes.
    const openSource = this.page.getByRole("button", { name: "Open Definition" });
    await expect(openSource).toBeVisible({ timeout: 5_000 });
    await openSource.click();
  }

  async debugRoutineFromTree(
    connection: RegExp,
    database: RegExp,
    schema: RegExp,
    routine: RegExp,
  ): Promise<void> {
    await this.tree.scrollToTop();
    await this.expectDatabaseIndexed(connection, database);
    const schemaItem = await this.tree.expandPath([
      connection,
      database,
      SCHEMAS_TREE_ITEM,
      schema,
    ]);
    const item = await this.tree.findChild(schemaItem, routine);
    await this.tree.hoverItem(item, routine);
    const debug = this.page.getByRole("button", { name: "Debug", exact: true });
    await expect(debug).toBeVisible({ timeout: 5_000 });
    await debug.click();
  }

  async openCockpit(): Promise<void> {
    await this.tree.clickHeaderAction(/Open Cockpit/i);
  }

  /**
   * The button of a modal confirmation. VS Code draws its own dialogs, and a tree row's inline
   * action carries the same accessible name as the button that confirms it — "Provision" names
   * both. Asking the page for that name reaches the row behind the dimmed block and waits there
   * until the action times out, so a confirmation is always asked for inside the dialog.
   */
  confirmation(label: string): Locator {
    return this.page
      .locator(".monaco-dialog-box")
      .getByRole("button", { name: label, exact: true });
  }

  async enableAndProvisionSchemaSync(connection: RegExp, database: RegExp): Promise<void> {
    let schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });
    await schemaSync.click();
    await this.quickInput.chooseAndClose(/Enable for this Connection/i);
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("provisioning required", { timeout: 5_000 });

    await this.tree.hoverItem(schemaSync, /^Schema synchronization/);
    await schemaSync.getByLabel(/^Provision$/i).click();
    const provision = this.confirmation("Provision");
    await expect(provision).toBeVisible({ timeout: 5_000 });
    await provision.click();
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("listening", { timeout: 10_000 });
  }

  async restartSchemaSync(connection: RegExp, database: RegExp): Promise<void> {
    let schemaSync = await this.schemaSyncItem(connection, database);
    await schemaSync.click();
    await this.quickInput.chooseAndClose(/Disable for this Connection/i);
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });

    await schemaSync.click();
    await this.quickInput.chooseAndClose(/Enable for this Connection/i);
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("listening", { timeout: 10_000 });
  }

  async removeAndDisableSchemaSync(connection: RegExp, database: RegExp): Promise<void> {
    let schemaSync = await this.schemaSyncItem(connection, database);
    await schemaSync.click();
    await this.quickInput.chooseAndClose(/Remove database provisioning/i);
    const remove = this.confirmation("Remove Provisioning");
    await expect(remove).toBeVisible({ timeout: 5_000 });
    await remove.click();
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("provisioning required", { timeout: 10_000 });
    await schemaSync.click();
    await this.quickInput.chooseAndClose(/Disable for this Connection/i);
    schemaSync = await this.schemaSyncItem(connection, database);
    await expect(schemaSync).toContainText("disabled", { timeout: 5_000 });
  }

  private async schemaSyncItem(connection: RegExp, database: RegExp): Promise<Locator> {
    const databaseItem = await this.tree.expandPath([connection, database]);
    const schemaSync = await this.tree.findChild(databaseItem, /^Schema synchronization/);
    return this.tree.waitForStableItem(schemaSync, "Schema synchronization");
  }

  async dragTreeItemToTextEditor(
    source: import("@playwright/test").Locator,
    target: import("@playwright/test").Locator,
    atFirstLine = false,
    primeTarget = true,
  ): Promise<void> {
    const dropTarget = atFirstLine
      ? target.locator(".view-line").first()
      : target.locator(".view-lines").first();
    await this.dragTreeItemToTarget(
      source,
      dropTarget,
      "application/vnd.postgresql-workbench.sql-object",
      atFirstLine,
      primeTarget,
    );
  }

  async dragTreeItemToDataView(
    source: import("@playwright/test").Locator,
    target: import("@playwright/test").Locator,
  ): Promise<void> {
    await this.dragTreeItemToTarget(
      source,
      target,
      "application/vnd.code.tree.postgresql-workbench-connections",
    );
  }

  private async dragTreeItemToTarget(
    source: import("@playwright/test").Locator,
    target: import("@playwright/test").Locator,
    acceptedMime: string,
    nearStart = false,
    primeTarget = true,
  ): Promise<void> {
    await this.tree.revealItem(source, "drag source");
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    expect(targetBox, "The VS Code editor area must have screen coordinates").not.toBeNull();
    const targetX = nearStart
      ? targetBox!.x + Math.min(80, targetBox!.width / 2)
      : targetBox!.x + targetBox!.width / 2;
    const targetY = nearStart
      ? targetBox!.y + Math.min(12, targetBox!.height / 2)
      : targetBox!.y + targetBox!.height / 2;
    // Without Shift, VS Code consumes the native drop through its editor overlay. The product
    // therefore composes at the cursor that was active when the drag began; prime that cursor at
    // the same screen position where this journey releases the object.
    if (primeTarget) await this.page.mouse.click(targetX, targetY);
    const { sourceBox, failedAttempts } = await startNativeTreeDrag(this.page, source);
    try {
      await this.page.mouse.move(targetX, targetY, { steps: 24 });
      try {
        await expect
          .poll(
            async () =>
              (await readDragProbe(this.page)).some(
                (event) =>
                  (event.type === "dragenter" || event.type === "dragover") &&
                  event.types.includes(acceptedMime),
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
    }
    await expect
      .poll(async () => (await readDragProbe(this.page)).some((event) => event.type === "drop"), {
        message: "VS Code must emit the accepted editor drop",
        timeout: 5_000,
      })
      .toBe(true);
  }
}

function regexMatches(pattern: RegExp, value: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "").replace("y", "")).test(value);
}
