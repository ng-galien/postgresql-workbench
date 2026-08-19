import {
  demoDatabaseTreeItem as database,
  demoConnectionId,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import type {
  VSCodeInstance,
  WorkbenchIndexPhase,
  WorkbenchStateSnapshot,
} from "../../fixtures/vscode";
import type { WorkbenchPage } from "../../pages/WorkbenchPage";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

async function waitForHeldPhase(
  vscode: VSCodeInstance,
  phase: WorkbenchIndexPhase,
  expectedRunId?: number,
): Promise<{ runId: number; snapshot: WorkbenchStateSnapshot }> {
  let snapshot: WorkbenchStateSnapshot | undefined;
  let matchedRunId: number | undefined;
  await expect
    .poll(
      async () => {
        snapshot = await vscode.inspectWorkbenchState();
        const gate = snapshot.index.gate;
        const reached =
          gate?.reachedPhase === phase &&
          typeof gate.runId === "number" &&
          (expectedRunId === undefined || gate.runId === expectedRunId);
        matchedRunId = reached ? gate.runId : undefined;
        return reached;
      },
      {
        timeout: 30_000,
        message: `Index run must be held at ${phase}`,
      },
    )
    .toBe(true);
  if (!snapshot || typeof matchedRunId !== "number") {
    throw new Error(`Index gate ${phase} reached without a runtime snapshot`);
  }
  return { runId: matchedRunId, snapshot };
}

async function currentSources(workbench: WorkbenchPage) {
  const activeDatabase = await workbench.tree.expandPath([server, database]);
  return {
    activeDatabase,
    sources: await workbench.tree.findChild(activeDatabase, SCHEMAS_TREE_ITEM),
  };
}

test.describe("Workbench indexing feedback", () => {
  test("keeps the previous snapshot visible through refresh, cancellation, and retry", async ({
    workbench,
    vscode,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectDatabaseIndexed(server, database);
    const baseline = await workbench.expectFreshIndexRuntime();
    const { sources } = await currentSources(workbench);
    await workbench.tree.expandItem(sources, SCHEMAS_TREE_ITEM);
    const schema = await workbench.tree.findChild(sources, /^shop/);
    await workbench.tree.expandItem(schema, /^shop/);
    const product = await workbench.tree.findChild(schema, /^product(?:\s|$)/);
    await expect(product).toBeVisible({ timeout: 5_000 });

    await test.step("show the refresh phase while retaining the previous snapshot", async () => {
      await vscode.armIndexPhaseGate(["reading-catalog"]);
      await workbench.tree.clickHeaderAction(/Reindex Database/i);
      const held = await waitForHeldPhase(vscode, "reading-catalog");
      expect(held.snapshot.index.activeRun?.retainedGeneration).toBe(baseline.generation);
      const { activeDatabase: refreshingDatabase, sources: refreshingSources } =
        await currentSources(workbench);
      await expect(refreshingSources).toContainText(/refreshing.*reading catalog/i, {
        timeout: 5_000,
      });
      await expect(refreshingDatabase).toContainText(/refreshing/i);
      await expect(refreshingSources).toHaveAccessibleName(
        /Schemas, demo, refreshing, reading catalog, previous snapshot available/i,
      );
      const refreshingSchema = await workbench.tree.expandPath([
        server,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop/,
      ]);
      const refreshingProduct = await workbench.tree.findChild(
        refreshingSchema,
        /^product(?:\s|$)/,
      );
      await workbench.tree.hoverItem(refreshingProduct, /^product(?:\s|$)/);
      const openDefinition = workbench.page.getByRole("button", {
        name: "Open PostgreSQL Definition",
      });
      await expect(openDefinition).toBeVisible({ timeout: 5_000 });
      await openDefinition.click();
      const sourceTab = workbench.page.getByRole("tab", { name: /^product(?:, preview)?$/i });
      await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
      await expect(
        workbench.page.locator(".editor-group-container.active .monaco-editor:visible"),
      ).toContainText(/CREATE\s+TABLE\s+"shop"\."product"/i, { timeout: 5_000 });
    });

    await test.step("cancel from the Sources node without losing the snapshot", async () => {
      const held = await vscode.inspectWorkbenchState();
      const runId = held.index.gate?.runId;
      if (typeof runId !== "number") {
        throw new Error("Index cancellation step requires a held acceptance run");
      }
      const { sources: cancellingSources } = await currentSources(workbench);
      await workbench.tree.hoverItem(cancellingSources, SCHEMAS_TREE_ITEM);
      const cancel = cancellingSources.getByRole("button", {
        name: /Cancel Database Indexing/i,
      });
      await expect(cancel).toBeVisible({ timeout: 5_000 });
      await cancel.click();
      const { sources: cancelledSources } = await currentSources(workbench);
      await expect(cancelledSources).toContainText(/cancelled.*previous snapshot available/i, {
        timeout: 5_000,
      });
      await expect(cancelledSources).toHaveAccessibleName(
        /Schemas, demo, indexing cancelled, previous snapshot available, select to retry/i,
      );
      await expect
        .poll(async () => {
          const state = await vscode.inspectWorkbenchState();
          return {
            active: state.index.activeRun?.id,
            generation: state.index.states.find(
              (entry) => entry.result?.serverId === demoConnectionId,
            )?.result?.generation,
            pending: state.index.currentRunPending,
            settled: state.index.lastSettledRun,
          };
        })
        .toEqual({
          active: undefined,
          generation: baseline.generation,
          pending: false,
          settled: { id: runId, status: "cancelled" },
        });
      const cancelledSchema = await workbench.tree.expandPath([
        server,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop/,
      ]);
      await workbench.tree.collapseItem(cancelledSchema, /^shop/);
      await workbench.tree.expandItem(cancelledSchema, /^shop/);
      const restoredProduct = await workbench.tree.findChild(cancelledSchema, /^product(?:\s|$)/);
      await expect(restoredProduct).toBeVisible();
    });

    await test.step("retry with real phase and count feedback", async () => {
      await vscode.armIndexPhaseGate(["reading-catalog", "publishing-sources", "reading-symbols"]);
      await workbench.tree.clickHeaderAction(/Reindex Database/i);
      const readingCatalog = await waitForHeldPhase(vscode, "reading-catalog");
      let current = await currentSources(workbench);
      await expect(current.sources).toContainText(/refreshing.*reading catalog/i);
      await vscode.releaseIndexPhaseGate(readingCatalog.runId, "reading-catalog");

      await waitForHeldPhase(vscode, "publishing-sources", readingCatalog.runId);
      current = await currentSources(workbench);
      await expect(current.sources).toContainText(/publishing \d+ sources?/i);
      await vscode.releaseIndexPhaseGate(readingCatalog.runId, "publishing-sources");

      await waitForHeldPhase(vscode, "reading-symbols", readingCatalog.runId);
      current = await currentSources(workbench);
      await expect(current.sources).toContainText(/reading(?: \d+)? symbols?/i);
      await vscode.releaseIndexPhaseGate(readingCatalog.runId, "reading-symbols");

      await workbench.expectFreshIndexRuntime({
        settledRunId: readingCatalog.runId,
      });
      const finalState = await vscode.inspectWorkbenchState();
      expect(
        finalState.index.events
          .filter(({ runId }) => runId === readingCatalog.runId)
          .map(({ phase }) => phase)
          .filter((phase): phase is WorkbenchIndexPhase => phase !== undefined),
      ).toEqual(
        expect.arrayContaining(["reading-catalog", "publishing-sources", "reading-symbols"]),
      );
      const { sources: availableSources } = await currentSources(workbench);
      await expect(availableSources).toContainText(/available.*\d+ sources?.*\d+ symbols?/i, {
        timeout: 30_000,
      });
      const availableSchema = await workbench.tree.expandPath([
        server,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop/,
      ]);
      await expect(
        await workbench.tree.findChild(availableSchema, /^product(?:\s|$)/),
      ).toBeVisible();
      await expect(
        workbench.page.locator(".notification-toast:visible").filter({
          hasText: /Indexed .* PostgreSQL|PostgreSQL indexing failed/i,
        }),
      ).toHaveCount(0);
    });
  });
});
