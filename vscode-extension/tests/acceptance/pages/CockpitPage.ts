import { expect, type Frame, type Locator } from "@playwright/test";
import { installDragProbe, readDragProbe, startNativeTreeDrag } from "../support/dragProbe";
import { currentPage, type PageProvider } from "./PageProvider";

export class CockpitPage {
  private frame?: Frame;

  constructor(private readonly pageProvider: PageProvider) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  async waitUntilOpen(): Promise<void> {
    this.frame = await this.findFrame();
    await expect(this.canvas).toBeVisible({ timeout: 5_000 });
  }

  get canvas(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".cockpit-canvas");
  }

  get emptyState(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".cockpit-empty");
  }

  get inspector(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".cockpit-inspector");
  }

  get sourceBody(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".source-body");
  }

  get dropFeedback(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".cockpit-drop-feedback");
  }

  get error(): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(".cockpit-error");
  }

  object(label: RegExp): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.getByLabel(label);
  }

  node(label: string): Locator {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.locator(`.cockpit-node[data-graph-label="${label}"]`);
  }

  ddlToggle(label: string): Locator {
    return this.node(label).getByRole("button", { name: "DDL", exact: true });
  }

  sourceToggleState(label: string): Locator {
    return this.node(label).locator(".node-source-toggle");
  }

  async showSource(label: string): Promise<void> {
    const source = this.ddlToggle(label);
    await source.waitFor({ state: "visible", timeout: 5_000 });
    await source.click();
    await this.inspector.waitFor({ state: "visible", timeout: 5_000 });
    await expect(this.sourceToggleState(label)).toHaveAttribute("aria-pressed", "true", {
      timeout: 5_000,
    });
  }

  async openIndexedDefinition(label: string): Promise<void> {
    const open = this.node(label).getByRole("button", { name: /^Open/ });
    await open.waitFor({ state: "visible", timeout: 5_000 });
    await open.click();
  }

  async focusNode(label: string): Promise<void> {
    const node = this.node(label).locator(".node-main");
    await node.waitFor({ state: "visible", timeout: 5_000 });
    await node.click();
    await expect(this.node(label)).toHaveAttribute("data-graph-role", "focus", {
      timeout: 5_000,
    });
  }

  async pinSource(): Promise<void> {
    await this.inspector.getByRole("button", { name: "Pin source preview", exact: true }).click();
    await expect(
      this.inspector.getByRole("button", { name: "Unpin source preview", exact: true }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });
  }

  async unpinSource(): Promise<void> {
    await this.inspector.getByRole("button", { name: "Unpin source preview", exact: true }).click();
    await expect(
      this.inspector.getByRole("button", { name: "Pin source preview", exact: true }),
    ).toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
  }

  async closeSourceWithButton(): Promise<void> {
    await this.inspector.getByRole("button", { name: "Close", exact: true }).click();
    await this.inspector.waitFor({ state: "hidden", timeout: 5_000 });
  }

  async closeSourceWithEscape(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.inspector.waitFor({ state: "hidden", timeout: 5_000 });
  }

  async recenter(): Promise<void> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    await this.frame.getByRole("button", { name: /Recenter/ }).click();
    await this.waitForViewportSettled();
  }

  async resizeSourceWidth(delta: number): Promise<void> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    const handle = this.frame.locator(".inspector-resize-handle");
    const box = await handle.boundingBox();
    expect(box, "The Source View resize handle must have screen coordinates").not.toBeNull();
    await this.page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(40, box!.height / 2));
    await this.page.mouse.down();
    await this.page.mouse.move(box!.x + box!.width / 2 - delta, box!.y + 40, { steps: 8 });
    await this.page.mouse.up();
  }

  async resizeSourceHeight(delta: number): Promise<void> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    const handle = this.frame.locator('.inspector-resize-handle[aria-orientation="horizontal"]');
    const box = await handle.boundingBox();
    expect(box, "The bottom Source View resize handle must have screen coordinates").not.toBeNull();
    await this.page.mouse.move(box!.x + Math.min(40, box!.width / 2), box!.y + box!.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(box!.x + 40, box!.y + box!.height / 2 - delta, { steps: 8 });
    await this.page.mouse.up();
  }

  async dragTreeItem(source: Locator): Promise<void> {
    await source.scrollIntoViewIfNeeded();
    await installDragProbe(this.frame!);
    const targetBox = await this.canvas.boundingBox();
    const frameBox = await (await this.frame!.frameElement()).boundingBox();
    expect(targetBox, "The Cockpit canvas must have screen coordinates").not.toBeNull();
    const { sourceBox, failedAttempts } = await startNativeTreeDrag(this.page, source);
    await this.page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2,
      { steps: 24 },
    );
    try {
      await expect(this.dropFeedback).toHaveAttribute("data-drop-availability", "accepted", {
        timeout: 5_000,
      });
    } catch (cause) {
      const sourceEvents = (await readDragProbe(this.page)).slice(-40);
      const targetEvents = (await readDragProbe(this.frame!)).slice(-40);
      throw new Error(
        `Drag feedback did not appear. sourceBox=${JSON.stringify(sourceBox)}; frameBox=${JSON.stringify(frameBox)}; targetBox=${JSON.stringify(targetBox)}; Workbench events=${JSON.stringify(sourceEvents)}; Cockpit events=${JSON.stringify(targetEvents)}; failedStartAttempts=${JSON.stringify(failedAttempts)}.`,
        { cause },
      );
    } finally {
      await this.page.mouse.up();
    }
    await expect
      .poll(async () => (await readDragProbe(this.page)).some((event) => event.type === "drop"), {
        message: `VS Code must accept the final drop on the Cockpit overlay. Workbench events=${JSON.stringify(
          (await readDragProbe(this.page)).slice(-40),
        )}; Cockpit events=${JSON.stringify((await readDragProbe(this.frame!)).slice(-40))}`,
        timeout: 5_000,
      })
      .toBe(true);
  }

  async previewRejectedTreeItem(source: Locator, reason: RegExp): Promise<void> {
    await source.scrollIntoViewIfNeeded();
    const targetBox = await this.canvas.boundingBox();
    expect(targetBox, "The Cockpit canvas must have screen coordinates").not.toBeNull();
    await startNativeTreeDrag(this.page, source);
    await this.page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height / 2,
      { steps: 24 },
    );
    try {
      await expect(this.dropFeedback).toHaveAttribute("data-drop-availability", "unsupported", {
        timeout: 5_000,
      });
      await expect(this.dropFeedback).toContainText(reason);
    } finally {
      await this.page.mouse.up();
      await this.page.mouse.move(10, 10);
      await expect(this.dropFeedback).toBeHidden({ timeout: 5_000 });
    }
  }

  async inspectorPlacement(): Promise<"side" | "bottom" | "overlap"> {
    const declared = await this.inspector.getAttribute("data-inspector-placement");
    if (declared === "side" || declared === "bottom") return declared;
    const canvas = await this.canvas.boundingBox();
    const inspector = await this.inspector.boundingBox();
    if (!canvas || !inspector) return "overlap";
    if (inspector.x >= canvas.x + canvas.width - 2) return "side";
    if (inspector.y >= canvas.y + canvas.height - 2) return "bottom";
    return "overlap";
  }

  async graphCenteringError(): Promise<number> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.evaluate(() => {
      const canvas = document.querySelector(".cockpit-canvas")?.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".react-flow__node")]
        .map((node) => node.getBoundingClientRect())
        .filter((node) => node.width > 0 && node.height > 0);
      if (!canvas || nodes.length === 0) return Number.POSITIVE_INFINITY;
      const left = Math.min(...nodes.map((node) => node.left));
      const right = Math.max(...nodes.map((node) => node.right));
      const top = Math.min(...nodes.map((node) => node.top));
      const bottom = Math.max(...nodes.map((node) => node.bottom));
      const horizontal =
        Math.abs((left + right) / 2 - (canvas.left + canvas.right) / 2) / canvas.width;
      const vertical =
        Math.abs((top + bottom) / 2 - (canvas.top + canvas.bottom) / 2) / canvas.height;
      return Math.max(horizontal, vertical);
    });
  }

  async sourceViewGeometry(): Promise<{
    main: { width: number; height: number };
    canvas: { width: number; height: number };
    inspector: { width: number; height: number };
    source: { width: number; height: number };
    sourceBody: { width: number; height: number };
    totalLines: number;
    fullyVisibleLines: number;
    codeFontSize: number;
  }> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    await this.frame
      .locator(".source-body .view-line")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    return this.frame.evaluate(() => {
      const size = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (!rect) throw new Error(`Missing Cockpit layout element: ${selector}`);
        return { width: rect.width, height: rect.height };
      };
      return {
        main: size(".cockpit-main"),
        canvas: size(".cockpit-canvas"),
        inspector: size(".cockpit-inspector"),
        source: size(".source-inspector"),
        sourceBody: size(".source-body"),
        totalLines: document.querySelectorAll(".source-body .view-line").length,
        fullyVisibleLines: (() => {
          const body = document.querySelector(".source-body")?.getBoundingClientRect();
          if (!body) return 0;
          return [...document.querySelectorAll(".source-body .view-line")].filter((line) => {
            const rect = line.getBoundingClientRect();
            return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1;
          }).length;
        })(),
        codeFontSize: (() => {
          const code = document.querySelector(".source-body .view-line");
          return code ? Number.parseFloat(getComputedStyle(code).fontSize) : 0;
        })(),
      };
    });
  }

  async canvasGeometry(): Promise<{ width: number; height: number }> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("The Cockpit canvas is not measurable");
    return { width: box.width, height: box.height };
  }

  async graphReadability(): Promise<{
    zoom: number;
    nodeCount: number;
    nodesInsideCanvas: number;
    minimumNodeWidth: number;
  }> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.evaluate(() => {
      const canvas = document.querySelector(".cockpit-canvas")?.getBoundingClientRect();
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      const nodes = [...document.querySelectorAll(".react-flow__node")]
        .map((node) => node.getBoundingClientRect())
        .filter((node) => node.width > 0 && node.height > 0);
      if (!canvas || !viewport || nodes.length === 0) {
        return {
          zoom: Number.NaN,
          nodeCount: nodes.length,
          nodesInsideCanvas: 0,
          minimumNodeWidth: 0,
        };
      }
      const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      const tolerance = 2;
      return {
        zoom: matrix.a,
        nodeCount: nodes.length,
        nodesInsideCanvas: nodes.filter(
          (node) =>
            node.left >= canvas.left - tolerance &&
            node.right <= canvas.right + tolerance &&
            node.top >= canvas.top - tolerance &&
            node.bottom <= canvas.bottom + tolerance,
        ).length,
        minimumNodeWidth: Math.min(...nodes.map((node) => node.width)),
      };
    });
  }

  async zoom(): Promise<number> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    return this.frame.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (!viewport) return Number.NaN;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      return matrix.a;
    });
  }

  async zoomByWheel(deltaY: number): Promise<void> {
    const box = await this.canvas.boundingBox();
    expect(box, "The Cockpit canvas must have screen coordinates").not.toBeNull();
    await this.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await this.page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await this.page.mouse.wheel(0, deltaY);
    await this.page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  }

  async nodePresentation(label: string): Promise<{
    logicalWidth: number;
    logicalHeight: number;
    compact: boolean;
    name: string;
    nameVisible: boolean;
    dragHandleVisible: boolean;
  }> {
    return this.node(label).evaluate((card) => {
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      const name = card.querySelector<HTMLElement>(".node-title strong");
      const dragHandle = card.querySelector<HTMLElement>(".node-drag-handle");
      const zoom = viewport
        ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
        : Number.NaN;
      const rect = card.getBoundingClientRect();
      const isVisible = (element: HTMLElement | null) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      };
      return {
        logicalWidth: rect.width / zoom,
        logicalHeight: rect.height / zoom,
        compact: card.classList.contains("zoom-compact"),
        name: name?.textContent?.trim() ?? "",
        nameVisible: isVisible(name),
        dragHandleVisible: isVisible(dragHandle),
      };
    });
  }

  async repositionNode(label: string, delta: { x: number; y: number }): Promise<void> {
    const card = this.node(label);
    const wrapper = card.locator("..");
    const handle = card.locator(".node-drag-handle");
    const before = await wrapper.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before, `${label} must have screen coordinates`).not.toBeNull();
    expect(handleBox, `${label} drag handle must have screen coordinates`).not.toBeNull();
    await this.page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    );
    await this.page.mouse.down();
    await this.page.mouse.move(
      handleBox!.x + handleBox!.width / 2 + 10,
      handleBox!.y + handleBox!.height / 2 + 6,
      { steps: 3 },
    );
    await expect(wrapper).toHaveClass(/dragging/, { timeout: 5_000 });
    await this.page.mouse.move(
      handleBox!.x + handleBox!.width / 2 + delta.x,
      handleBox!.y + handleBox!.height / 2 + delta.y,
      { steps: 9 },
    );
    const during = await wrapper.boundingBox();
    expect(during, `${label} must remain measurable while dragging`).not.toBeNull();
    expect(Math.hypot(during!.x - before!.x, during!.y - before!.y)).toBeGreaterThan(20);
    await this.page.mouse.up();
    await expect
      .poll(
        async () => {
          const after = await wrapper.boundingBox();
          return after ? Math.hypot(after.x - before!.x, after.y - before!.y) : 0;
        },
        { timeout: 5_000, message: `${label} must keep its dropped graph position` },
      )
      .toBeGreaterThan(20);
  }

  async expectNodeBodyNotToDrag(label: string, delta: { x: number; y: number }): Promise<void> {
    const card = this.node(label);
    const wrapper = card.locator("..");
    const body = card.locator(".node-main");
    const before = await wrapper.boundingBox();
    const bodyBox = await body.boundingBox();
    expect(before, `${label} must have screen coordinates`).not.toBeNull();
    expect(bodyBox, `${label} body must have screen coordinates`).not.toBeNull();
    await this.page.mouse.move(bodyBox!.x + bodyBox!.width / 2, bodyBox!.y + bodyBox!.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(
      bodyBox!.x + bodyBox!.width / 2 + delta.x,
      bodyBox!.y + bodyBox!.height / 2 + delta.y,
      { steps: 9 },
    );
    await this.page.mouse.up();
    const after = await wrapper.boundingBox();
    expect(after, `${label} must remain measurable after dragging its body`).not.toBeNull();
    expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeLessThan(5);
  }

  async nodePortVerticalError(label: string): Promise<number> {
    return this.node(label).evaluate((card) => {
      const cardRect = card.getBoundingClientRect();
      const center = cardRect.top + cardRect.height / 2;
      return Math.max(
        ...[...card.querySelectorAll<HTMLElement>(".cockpit-port")].map((port) => {
          const rect = port.getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - center);
        }),
      );
    });
  }

  private async waitForViewportSettled(): Promise<void> {
    if (!this.frame) throw new Error("CockpitPage.waitUntilOpen() must be called first");
    await this.frame.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
          if (!viewport) {
            reject(new Error("The React Flow viewport is missing"));
            return;
          }
          const deadline = performance.now() + 5_000;
          let previous = "";
          let stableFrames = 0;
          const sample = () => {
            const current = getComputedStyle(viewport).transform;
            stableFrames = current === previous ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 4) {
              resolve();
              return;
            }
            if (performance.now() >= deadline) {
              reject(new Error("The React Flow viewport did not settle within 5000 ms"));
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
  }

  private async findFrame(): Promise<Frame> {
    const current = this.page
      .frames()
      .find(
        (frame) => frame !== this.page.mainFrame() && frame.url().startsWith("vscode-webview://"),
      );
    if (current && (await current.locator(".cockpit-canvas").count()) > 0) return current;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if (
          frame !== this.page.mainFrame() &&
          (await frame.locator(".cockpit-canvas").count()) > 0
        ) {
          return frame;
        }
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error("The PostgreSQL Cockpit webview frame did not become available.");
  }
}
