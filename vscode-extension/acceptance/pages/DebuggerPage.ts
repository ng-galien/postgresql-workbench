import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import type { DebugStateSnapshot } from "../fixtures/vscode";
import { QuickInput } from "./QuickInput";

export class DebuggerPage {
  private readonly quickInput: QuickInput;

  constructor(
    private readonly page: Page,
    private readonly openWorkspaceFile: (fileName: string) => Promise<void>,
    private readonly inspectDebugState: () => Promise<DebugStateSnapshot>,
    private readonly executeCommand: (
      command:
        | "workbench.action.debug.continue"
        | "workbench.action.debug.stepInto"
        | "workbench.action.debug.stepOver",
      timeout?: number,
    ) => Promise<void>,
  ) {
    this.quickInput = new QuickInput(page);
  }

  async openCallSite(fileName: string): Promise<void> {
    await this.openWorkspaceFile(fileName);
    await expect(
      this.page.getByRole("tab", { name: new RegExp(fileName.replace(".", "\\.")) }),
    ).toBeVisible({
      timeout: 5_000,
    });
  }

  async setBreakpoint(sourceLine: string): Promise<void> {
    const registeredBefore = (await this.readDebugState()).breakpoints?.length ?? 0;
    const editor = this.activeEditor();
    await this.revealLine(sourceLine, editor, 10_000);
    await expect(editor.locator(".codelens-decoration").first()).toBeVisible({ timeout: 10_000 });
    const markers = editor.locator(".glyph-margin-widgets > div");
    const markerCount = await markers.count();
    const target = await this.stableBreakpointTarget(editor, sourceLine);
    await this.page.mouse.click(target.x, target.y);
    await expect
      .poll(() => markers.count(), {
        timeout: 5_000,
        message: `The editor must display a breakpoint marker on ${sourceLine}`,
      })
      .toBe(markerCount + 1);
    await expect
      .poll(
        async () => {
          const breakpoints = (await this.readDebugState()).breakpoints ?? [];
          return breakpoints.length === registeredBefore + 1 ? breakpoints.at(-1)?.line : undefined;
        },
        {
          timeout: 5_000,
          message: `VS Code must register the breakpoint on visible line ${target.line}: ${sourceLine}`,
        },
      )
      .toBe(target.line);
  }

  async assignConnection(sql: string, connection: RegExp): Promise<void> {
    const line = await this.revealLine(sql);
    await this.clickNearestCodeLens(line, /Choose PostgreSQL connection/);
    await this.quickInput.chooseOption(connection);
    await this.quickInput.input.waitFor({ state: "hidden", timeout: 5_000 });
    await expect(await this.nearestCodeLens(line, /Debug PL\/pgSQL/)).toBeVisible({
      timeout: 5_000,
    });
  }

  async start(
    sql: string,
    sourceTab: RegExp,
    routineSource: RegExp,
    expectedStopLine?: string,
  ): Promise<void> {
    const line = await this.revealLine(sql);
    await this.clickNearestCodeLens(line, /Debug PL\/pgSQL/);
    await this.expectRoutineEditor(sourceTab, routineSource, expectedStopLine);
  }

  async expectRoutineEditor(
    sourceTab: RegExp,
    routineSource: RegExp,
    expectedStopLine?: string,
  ): Promise<void> {
    await expect(this.debugToolbar()).toBeVisible({ timeout: 20_000 });
    const tab = this.page.getByRole("tab", { name: sourceTab });
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
    await expect(
      this.page.locator(".view-line:visible").filter({ hasText: routineSource }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
    if (expectedStopLine) await this.expectStoppedAt(expectedStopLine);
  }

  async continueToCompletion(expectedResult?: string): Promise<void> {
    await expect(this.debugToolbar()).toBeVisible({ timeout: 5_000 });
    await this.executeCommand("workbench.action.debug.continue");
    const results = await this.resultsFrame();
    await expect(results.locator(".badge.status-success")).toHaveText("Completed", {
      timeout: 20_000,
    });
    await expect(results.locator(".badge.status-pending")).toHaveCount(0, {
      timeout: 5_000,
    });
    if (expectedResult !== undefined) {
      const resultCells = results.locator("tbody td").filter({
        hasText: new RegExp(`^${expectedResult.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      });
      await expect(resultCells).toHaveCount(1, { timeout: 5_000 });
      await expect(resultCells.first()).toHaveText(expectedResult, { timeout: 5_000 });
    }
    await expect(this.debugToolbar()).toBeHidden({ timeout: 5_000 });
    await this.expectNoActiveSession();
  }

  async expectNoActiveSession(): Promise<void> {
    const deadline = Date.now() + 5_000;
    let state: DebugStateSnapshot = {};
    while (Date.now() < deadline) {
      state = await this.readDebugState();
      if (!state.vscodeSessionId && !state.extensionSession) return;
      await this.page.waitForTimeout(50);
    }
    throw new Error(`A debugger session remained active after teardown: ${JSON.stringify(state)}`);
  }

  async continueToStop(
    sourceTab: RegExp,
    routineSource: RegExp,
    expectedStopLine: string,
  ): Promise<void> {
    await expect(this.debugToolbar()).toBeVisible({ timeout: 5_000 });
    await this.executeCommand("workbench.action.debug.continue");
    await expect(this.page.getByRole("tab", { name: sourceTab })).toBeVisible({ timeout: 10_000 });
    await expect(
      this.page.locator(".view-line:visible").filter({ hasText: routineSource }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await this.expectStoppedAt(expectedStopLine);
  }

  async stepInto(
    sourceTab: RegExp,
    routineSource: RegExp,
    expectedStopLine: string,
  ): Promise<void> {
    await expect(this.debugToolbar()).toBeVisible({ timeout: 5_000 });
    await this.executeCommand("workbench.action.debug.stepInto");
    await expect(this.page.getByRole("tab", { name: sourceTab })).toBeVisible({ timeout: 10_000 });
    await expect(
      this.page.locator(".view-line:visible").filter({ hasText: routineSource }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await this.expectStoppedAt(expectedStopLine);
  }

  async stepOver(expectedStopLine: string): Promise<void> {
    await expect(this.debugToolbar()).toBeVisible({ timeout: 5_000 });
    await this.executeCommand("workbench.action.debug.stepOver");
    await this.expectStoppedAt(expectedStopLine);
  }

  async expectVariable(name: string, value: string): Promise<void> {
    await this.expectScopedVariable(/Local Variables$/, name, value);
  }

  async expectNoErrorNotification(): Promise<void> {
    await expect(this.page.locator(".notification-toast:visible .codicon-error")).toHaveCount(0, {
      timeout: 5_000,
    });
  }

  async expectNoCoverageDecorations(): Promise<void> {
    await expect(
      this.page.locator(
        ".editor-group-container.active .monaco-editor:visible .coverage-deco-inline",
      ),
    ).toHaveCount(0, { timeout: 5_000 });
  }

  async expectArgument(name: string, value: string): Promise<void> {
    await this.expectScopedVariable(/Arguments$/, name, value);
  }

  async continueToRecursiveReturn(
    sourceLine: string,
    argumentValue: string,
    resultValue: string,
  ): Promise<void> {
    const previousStop = await this.readDebugState();
    const previousTimestamp = previousStop.extensionSession?.status?.timestamp;
    if (previousStop.extensionSession?.state !== "suspended" || !previousTimestamp) {
      throw new Error(
        `Recursive continue requires a suspended debugger with a timestamped DAP status: ${JSON.stringify(previousStop)}`,
      );
    }
    await expect(this.debugToolbar()).toBeVisible({ timeout: 5_000 });
    await this.executeCommand("workbench.action.debug.continue");
    await expect
      .poll(
        async () => {
          const current = await this.readDebugState();
          return current.extensionSession?.state === "suspended"
            ? current.extensionSession.status?.timestamp
            : previousTimestamp;
        },
        {
          timeout: 10_000,
          message: "The debugger must publish a new suspended DAP status after Continue",
        },
      )
      .not.toBe(previousTimestamp);
    await this.expectArgument("n", argumentValue);
    await this.expectStoppedAt(sourceLine);
    await this.expectVariable("result", resultValue);
  }

  private async expectScopedVariable(
    scopeName: RegExp,
    name: string,
    value: string,
  ): Promise<void> {
    const scope = this.page.getByRole("treeitem", { name: scopeName }).first();
    await expect(scope).toBeVisible({ timeout: 5_000 });
    if ((await scope.getAttribute("aria-expanded")) !== "true") await scope.click();
    await expect(
      this.page.getByRole("treeitem", { name: `${name}, value ${value}`, exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  }

  private debugToolbar(): Locator {
    return this.page.locator(".debug-toolbar:visible").first();
  }

  private async resultsFrame(): Promise<Frame> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame() || frame.isDetached()) continue;
        try {
          if ((await frame.locator("#history").count()) > 0) return frame;
        } catch (error) {
          if (!frame.isDetached()) throw error;
        }
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error("The PL/pgSQL Results webview frame did not become available within 5000 ms");
  }

  private async expectStoppedAt(sourceLine: string): Promise<void> {
    const editor = this.activeEditor();
    const marker = editor.locator(".codicon-debug-stackframe").first();
    await expect(marker).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const line = await this.revealLine(sourceLine, editor);
          const [lineBox, markerBox] = await Promise.all([
            line.boundingBox(),
            marker.boundingBox(),
          ]);
          if (!lineBox || !markerBox) return Number.POSITIVE_INFINITY;
          return Math.abs(lineBox.y + lineBox.height / 2 - (markerBox.y + markerBox.height / 2));
        },
        {
          timeout: 10_000,
          message: `The active stack-frame marker must settle on ${sourceLine}`,
        },
      )
      .toBeLessThan(4);
  }

  private activeEditor(): Locator {
    return this.page.locator(".editor-group-container.active .monaco-editor:visible").first();
  }

  private async revealLine(
    sql: string,
    editor = this.activeEditor(),
    timeout = 5_000,
  ): Promise<Locator> {
    const line = editor.locator(".view-line").filter({ hasText: sql }).first();
    await line.waitFor({ state: "visible", timeout });
    return line;
  }

  private async stableBreakpointTarget(
    editor: Locator,
    sourceLine: string,
  ): Promise<{ line: number; x: number; y: number }> {
    const deadline = Date.now() + 5_000;
    let previous: { line: number; x: number; y: number } | undefined;
    while (Date.now() < deadline) {
      const current = await editor.evaluate((root, expectedText) => {
        const normalize = (value: string | null) => (value ?? "").replace(/\s+/gu, " ").trim();
        const line = [...root.querySelectorAll<HTMLElement>(".view-line")].find((candidate) =>
          normalize(candidate.textContent).includes(expectedText),
        );
        const margin = root.querySelector<HTMLElement>(".margin-view-overlays");
        if (!line || !margin) return undefined;
        const lineBox = line.getBoundingClientRect();
        const marginBox = margin.getBoundingClientRect();
        const center = lineBox.top + lineBox.height / 2;
        const visibleLineNumber = [...root.querySelectorAll<HTMLElement>(".line-numbers")]
          .map((candidate) => {
            const box = candidate.getBoundingClientRect();
            return {
              distance: Math.abs(box.top + box.height / 2 - center),
              line: Number.parseInt(normalize(candidate.textContent), 10),
            };
          })
          .filter((candidate) => Number.isFinite(candidate.line))
          .sort((left, right) => left.distance - right.distance)[0];
        if (!visibleLineNumber || visibleLineNumber.distance >= 4) return undefined;
        return { line: visibleLineNumber.line, x: marginBox.left + 12, y: center };
      }, sourceLine);
      if (
        current &&
        previous?.line === current.line &&
        Math.abs(previous.x - current.x) < 0.5 &&
        Math.abs(previous.y - current.y) < 0.5
      ) {
        return current;
      }
      previous = current;
      await this.page.waitForTimeout(50);
    }
    throw new Error(`The active editor geometry did not settle on ${sourceLine} within 5000 ms`);
  }

  private async readDebugState(): Promise<DebugStateSnapshot> {
    try {
      return await this.inspectDebugState();
    } catch {
      await this.page.waitForTimeout(50);
      return this.inspectDebugState();
    }
  }

  private async waitForBoundingBox(
    locator: Locator,
    message: string,
  ): Promise<NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const box = await locator.boundingBox();
      if (box) return box;
      await this.page.waitForTimeout(50);
    }
    throw new Error(`${message} within 5000 ms`);
  }

  private async nearestCodeLens(line: Locator, label: RegExp): Promise<Locator> {
    const lenses = this.page.getByRole("button", { name: label });
    let nearestIndex = -1;
    await expect
      .poll(
        async () => {
          const lineBox = await line.boundingBox();
          if (!lineBox) return false;
          let nearest: { distance: number; index: number } | undefined;
          for (let index = 0; index < (await lenses.count()); index++) {
            const box = await lenses.nth(index).boundingBox();
            if (!box) continue;
            const lineCenter = lineBox.y + lineBox.height / 2;
            const lensCenter = box.y + box.height / 2;
            if (lensCenter > lineCenter) continue;
            const distance = lineCenter - lensCenter;
            if (!nearest || distance < nearest.distance) nearest = { distance, index };
          }
          nearestIndex = nearest?.index ?? -1;
          return nearestIndex >= 0;
        },
        {
          timeout: 5_000,
          message: `A visible CodeLens ${label} must precede the SQL line ${await line.innerText()}`,
        },
      )
      .toBe(true);
    return lenses.nth(nearestIndex);
  }

  private async clickNearestCodeLens(line: Locator, label: RegExp): Promise<void> {
    const lens = await this.nearestCodeLens(line, label);
    const box = await this.waitForBoundingBox(
      lens,
      `The visible CodeLens ${label} must have screen coordinates`,
    );
    // VS Code recreates CodeLens anchors when another lens on the same document
    // changes. A locator click can therefore retain an nth() target that is
    // detached during actionability checks. Clicking the freshly measured
    // screen position preserves the real UI interaction without retaining the
    // transient DOM node.
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}
