import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import type { DebugStateSnapshot } from "../fixtures/vscode";
import { QuickInput } from "./QuickInput";

export class DebuggerPage {
  private readonly quickInput: QuickInput;

  constructor(
    private readonly page: Page,
    private readonly executeCommand: (command: "workbench.action.quickOpen") => Promise<void>,
    private readonly inspectDebugState: () => Promise<DebugStateSnapshot>,
  ) {
    this.quickInput = new QuickInput(page);
  }

  async openCallSite(fileName: string): Promise<void> {
    await this.executeCommand("workbench.action.quickOpen");
    await this.quickInput.input.waitFor({ state: "visible", timeout: 5_000 });
    await this.quickInput.input.fill(fileName);
    await this.quickInput.chooseOption(new RegExp(`^${fileName.replace(".", "\\.")}`));
    await this.quickInput.input.waitFor({ state: "hidden", timeout: 5_000 });
    await expect(
      this.page.getByRole("tab", { name: new RegExp(fileName.replace(".", "\\.")) }),
    ).toBeVisible({
      timeout: 5_000,
    });
  }

  async setBreakpoint(sourceLine: string): Promise<void> {
    const registeredBefore = (await this.inspectDebugState()).breakpoints?.length ?? 0;
    const line = await this.revealLine(sourceLine);
    const margin = this.page.locator(".monaco-editor:visible .margin-view-overlays").first();
    const lineBox = await this.waitForBoundingBox(
      line,
      `The breakpoint line ${sourceLine} must have screen coordinates`,
    );
    const marginBox = await this.waitForBoundingBox(
      margin,
      "The active editor margin must have screen coordinates",
    );
    const markers = this.page.locator(".monaco-editor:visible .glyph-margin-widgets > div");
    const markerCount = await markers.count();
    await this.page.mouse.click(marginBox.x + 12, lineBox.y + lineBox.height / 2);
    await expect
      .poll(() => markers.count(), {
        timeout: 5_000,
        message: `The editor must display a breakpoint marker on ${sourceLine}`,
      })
      .toBe(markerCount + 1);
    await expect
      .poll(async () => (await this.inspectDebugState()).breakpoints?.length ?? 0, {
        timeout: 5_000,
        message: `VS Code must register the breakpoint through its debug API on ${sourceLine}`,
      })
      .toBe(registeredBefore + 1);
  }

  async assignConnection(sql: string, connection: RegExp): Promise<void> {
    const line = await this.revealLine(sql);
    const chooser = await this.nearestCodeLens(line, /Choose PostgreSQL connection/);
    await chooser.click();
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
    const debug = await this.nearestCodeLens(line, /Debug PL\/pgSQL/);
    await debug.click();
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
    const continueAction = this.debugToolbar().locator(".codicon-debug-continue").first();
    await expect(continueAction).toBeVisible({ timeout: 5_000 });
    await continueAction.click();
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
      state = await this.inspectDebugState();
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
    const continueAction = this.debugToolbar().locator(".codicon-debug-continue").first();
    await expect(continueAction).toBeVisible({ timeout: 5_000 });
    await continueAction.click();
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
    const stepIntoAction = this.debugToolbar().locator(".codicon-debug-step-into").first();
    await expect(stepIntoAction).toBeVisible({ timeout: 5_000 });
    await stepIntoAction.click();
    await expect(this.page.getByRole("tab", { name: sourceTab })).toBeVisible({ timeout: 10_000 });
    await expect(
      this.page.locator(".view-line:visible").filter({ hasText: routineSource }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await this.expectStoppedAt(expectedStopLine);
  }

  async stepOver(expectedStopLine: string): Promise<void> {
    const stepOverAction = this.debugToolbar().locator(".codicon-debug-step-over").first();
    await expect(stepOverAction).toBeVisible({ timeout: 5_000 });
    await stepOverAction.click();
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

  async expectArgument(name: string, value: string): Promise<void> {
    await this.expectScopedVariable(/Arguments$/, name, value);
  }

  async continueToRecursiveReturn(
    sourceLine: string,
    argumentValue: string,
    resultValue: string,
  ): Promise<void> {
    const previousStop = await this.inspectDebugState();
    const previousTimestamp = previousStop.extensionSession?.status?.timestamp;
    if (previousStop.extensionSession?.state !== "suspended" || !previousTimestamp) {
      throw new Error(
        `Recursive continue requires a suspended debugger with a timestamped DAP status: ${JSON.stringify(previousStop)}`,
      );
    }
    const continueAction = this.debugToolbar().locator(".codicon-debug-continue").first();
    await expect(continueAction).toBeVisible({ timeout: 5_000 });
    await continueAction.click();
    await expect
      .poll(
        async () => {
          const current = await this.inspectDebugState();
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
        if (frame !== this.page.mainFrame() && (await frame.locator("#history").count()) > 0) {
          return frame;
        }
      }
      await this.page.waitForTimeout(50);
    }
    throw new Error("The PL/pgSQL Results webview frame did not become available within 5000 ms");
  }

  private async expectStoppedAt(sourceLine: string): Promise<void> {
    const marker = this.page.locator(".monaco-editor:visible .codicon-debug-stackframe").first();
    await expect(marker).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const line = await this.revealLine(sourceLine);
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

  private async revealLine(sql: string): Promise<Locator> {
    const line = this.page.locator(".view-line:visible").filter({ hasText: sql }).first();
    await line.waitFor({ state: "visible", timeout: 5_000 });
    return line;
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
}
