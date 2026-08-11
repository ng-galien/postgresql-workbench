import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;
const database = /^demo/;

test.describe
  .serial("Workbench Cockpit TreeView journeys", () => {
    test("phase 1 — opens the graph from a TreeView drop", async ({ workbench, cockpit }) => {
      await test.step("connect and index the demo database through the Workbench UI", async () => {
        await workbench.addServer(demoConnectionUrl, server);
        await workbench.reindexActiveDatabase(server, database);
        await expect(workbench.tree.item(/^shop/)).toBeVisible();
      });

      await test.step("drop shop.address into the editor area to open the Cockpit", async () => {
        await workbench.tree.open();
        await workbench.tree.expandPath([server, database, /^Sources/, /^shop/]);
        const address = workbench.tree.item(/^address/);
        await expect(address).toBeVisible({ timeout: 5_000 });
        await workbench.dragTreeItemToEditor(address);
        await cockpit.waitUntilOpen();
        await expect(cockpit.object(/^address, PostgreSQL table\./i)).toBeVisible({
          timeout: 5_000,
        });
        await expect(cockpit.node("address")).toHaveAttribute("data-graph-role", "focus");
        await expect(cockpit.node("address").locator(".pin-flag")).toHaveCount(0);
        await expect(cockpit.inspector).toBeHidden({ timeout: 5_000 });
        await expect(cockpit.error).toBeHidden({ timeout: 5_000 });
        await expect(
          workbench.page.locator(".editor-group-container .tabs-container .tab"),
        ).toHaveCount(1);
      });
    });

    test("phase 1 — a later drop changes focus and preserves direct graph interactions", async ({
      workbench,
      cockpit,
    }) => {
      await cockpit.waitUntilOpen();
      await workbench.page.setViewportSize({ width: 1_440, height: 900 });

      await test.step("drop product into the open Cockpit exactly like selecting it", async () => {
        await workbench.tree.open();
        await workbench.tree.expandPath([server, database, /^Sources/, /^shop/]);
        const product = workbench.tree.item(/^product(?:\s|$)/);
        await expect(product).toBeVisible({ timeout: 5_000 });
        await cockpit.dragTreeItem(product);
        await expect(cockpit.object(/^product, PostgreSQL table\./i)).toBeVisible({
          timeout: 5_000,
        });
        await expect(cockpit.node("product")).toHaveAttribute("data-graph-role", "focus");
        await expect(cockpit.node("product").locator(".pin-flag")).toHaveCount(0);
        await expect(cockpit.node("address")).toHaveCount(0);
        await expect(cockpit.inspector).toBeHidden({ timeout: 5_000 });
        await expect(cockpit.error).toBeHidden({ timeout: 5_000 });
      });

      await test.step("reject a column without changing the current focus", async () => {
        await workbench.tree.open();
        await workbench.tree.expandPath([server, database, /^Sources/, /^shop/, /^address/]);
        const column = workbench.tree.item(/^id/);
        await expect(column).toBeVisible({ timeout: 5_000 });
        await cockpit.previewRejectedTreeItem(column, /parent table/i);
        await expect(cockpit.node("product")).toHaveAttribute("data-graph-role", "focus");
      });

      await test.step("apply a small bounded zoom, recenter, then reposition product", async () => {
        await cockpit.recenter();
        const initial = await cockpit.graphReadability();
        expect(initial.nodesInsideCanvas).toBe(initial.nodeCount);
        await cockpit.zoomByWheel(-120);
        await expect
          .poll(() => cockpit.zoom(), {
            timeout: 5_000,
            message: "A small mouse zoom must reach React Flow through the Cockpit surface",
          })
          .toBeGreaterThan(initial.zoom + 0.02);
        const zoomed = await cockpit.zoom();
        expect(zoomed).toBeLessThanOrEqual(initial.zoom + 0.3);
        await cockpit.recenter();
        await expect
          .poll(() => cockpit.graphCenteringError(), { timeout: 5_000 })
          .toBeLessThan(0.12);
        await cockpit.repositionNode("product", { x: 90, y: 55 });
      });
    });

    test("phase 2 — controls the side Source panel explicitly", async ({
      workbench,
      cockpit,
    }, testInfo) => {
      await cockpit.waitUntilOpen();
      await workbench.page.setViewportSize({ width: 1_440, height: 900 });

      await test.step("open Source from the address node and verify its side geometry", async () => {
        await cockpit.showSource("product");
        await expect(cockpit.sourceBody).toContainText(/CREATE\s+TABLE/i, { timeout: 5_000 });
        await expect
          .poll(() => cockpit.inspectorPlacement(), {
            timeout: 5_000,
            message: "Source must use the side layout at the desktop width",
          })
          .toBe("side");
        const initial = await cockpit.sourceViewGeometry();
        expect(initial.inspector.width).toBeGreaterThanOrEqual(360);
        expect(initial.inspector.height).toBeGreaterThanOrEqual(initial.main.height - 2);
        expect(initial.sourceBody.height).toBeGreaterThanOrEqual(220);
        expect(initial.fullyVisibleLines).toBeGreaterThanOrEqual(Math.min(8, initial.totalLines));
        expect(initial.codeFontSize).toBeGreaterThanOrEqual(11);

        await cockpit.resizeSourceWidth(70);
        await expect
          .poll(async () => (await cockpit.sourceViewGeometry()).inspector.width, {
            timeout: 5_000,
            message: "Dragging the side Source divider must resize the panel",
          })
          .toBeGreaterThan(initial.inspector.width + 25);
        await expect
          .poll(() => cockpit.graphCenteringError(), { timeout: 5_000 })
          .toBeLessThan(0.12);
        await testInfo.attach("source-view-side.png", {
          body: await workbench.page.screenshot(),
          contentType: "image/png",
        });
      });

      await test.step("pin the preview, then return to follow mode", async () => {
        await cockpit.pinSource();
        await cockpit.focusNode("brand");
        await expect(cockpit.inspector).toContainText(/product/i, { timeout: 5_000 });
        await cockpit.unpinSource();
        await cockpit.focusNode("product_availability");
        await expect(cockpit.inspector).toContainText(/product_availability/i, { timeout: 5_000 });
      });

      await test.step("close Source and recover the full graph width", async () => {
        const openCanvas = await cockpit.canvasGeometry();
        await cockpit.closeSourceWithButton();
        await expect(cockpit.ddlToggle("product_availability")).toHaveAttribute(
          "aria-pressed",
          "false",
          { timeout: 5_000 },
        );
        const closedCanvas = await cockpit.canvasGeometry();
        expect(closedCanvas.width).toBeGreaterThan(openCanvas.width + 300);
        await expect
          .poll(() => cockpit.graphCenteringError(), { timeout: 5_000 })
          .toBeLessThan(0.12);
      });
    });

    test("phase 2 — sizes and resizes the bottom Source panel", async ({
      workbench,
      cockpit,
    }, testInfo) => {
      await cockpit.waitUntilOpen();
      await workbench.page.setViewportSize({ width: 1_100, height: 850 });
      await cockpit.showSource("product_availability");

      await test.step("use the full bottom width without collapsing SQL", async () => {
        await expect.poll(() => cockpit.inspectorPlacement(), { timeout: 5_000 }).toBe("bottom");
        const geometry = await cockpit.sourceViewGeometry();
        expect(Math.abs(geometry.inspector.width - geometry.main.width)).toBeLessThan(3);
        expect(geometry.source.width / geometry.inspector.width).toBeGreaterThanOrEqual(0.98);
        expect(geometry.sourceBody.height).toBeGreaterThanOrEqual(150);
        expect(geometry.fullyVisibleLines).toBeGreaterThanOrEqual(Math.min(6, geometry.totalLines));
        expect(geometry.codeFontSize).toBeGreaterThanOrEqual(11);
      });

      await test.step("resize the bottom panel vertically and recenter the remaining canvas", async () => {
        const initial = await cockpit.sourceViewGeometry();
        await cockpit.resizeSourceHeight(70);
        await expect
          .poll(async () => (await cockpit.sourceViewGeometry()).inspector.height, {
            timeout: 5_000,
            message: "Dragging the bottom Source divider must resize panel height",
          })
          .toBeGreaterThan(initial.inspector.height + 35);
        await workbench.page.setViewportSize({ width: 1_100, height: 700 });
        await expect
          .poll(
            async () => {
              const geometry = await cockpit.sourceViewGeometry();
              return geometry.inspector.height / geometry.main.height;
            },
            {
              timeout: 5_000,
              message: "The bottom Source height must be clamped again after a viewport resize",
            },
          )
          .toBeLessThanOrEqual(0.56);
        await expect
          .poll(() => cockpit.graphCenteringError(), { timeout: 5_000 })
          .toBeLessThan(0.12);
        await testInfo.attach("source-view-bottom.png", {
          body: await workbench.page.screenshot(),
          contentType: "image/png",
        });
      });

      await cockpit.closeSourceWithEscape();
      await expect(cockpit.inspector).toBeHidden({ timeout: 5_000 });
    });
  });
