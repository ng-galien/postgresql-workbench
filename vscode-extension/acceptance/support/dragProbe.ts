import { expect, type Frame, type Locator, type Page } from "@playwright/test";

export interface DragProbeEvent {
  type: string;
  types: string[];
  target: string;
}

export interface NativeDragStart {
  sourceBox: { x: number; y: number; width: number; height: number };
  failedAttempts: Array<{
    sourceBox: { x: number; y: number; width: number; height: number };
    events: DragProbeEvent[];
  }>;
}

export async function installDragProbe(target: Page | Frame): Promise<void> {
  await target.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __pgwbDragProbe?: DragProbeEvent[];
      __pgwbDragProbeInstalled?: boolean;
    };
    state.__pgwbDragProbe = [];
    if (state.__pgwbDragProbeInstalled) return;
    state.__pgwbDragProbeInstalled = true;
    for (const type of ["dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"]) {
      document.addEventListener(
        type,
        (event) => {
          const drag = event as DragEvent;
          state.__pgwbDragProbe?.push({
            type,
            types: drag.dataTransfer ? [...drag.dataTransfer.types] : [],
            target:
              drag.target instanceof Element
                ? `${drag.target.tagName.toLocaleLowerCase()}.${drag.target.className}`
                : String(drag.target),
          });
        },
        { capture: true, once: false },
      );
    }
  });
}

export async function readDragProbe(target: Page | Frame): Promise<DragProbeEvent[]> {
  return target.evaluate(() => {
    const state = globalThis as typeof globalThis & { __pgwbDragProbe?: DragProbeEvent[] };
    return state.__pgwbDragProbe ?? [];
  });
}

/**
 * Start VS Code's native TreeView drag without releasing the mouse.
 *
 * Chromium can occasionally miss the first native gesture in an Electron
 * workbench. Retrying is safe only before `dragstart`: each failed attempt is
 * released and recorded, while callers still require the real accepted drop.
 */
export async function startNativeTreeDrag(page: Page, source: Locator): Promise<NativeDragStart> {
  const failedAttempts: NativeDragStart["failedAttempts"] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await installDragProbe(page);
    const sourceBox = await source.boundingBox();
    expect(sourceBox, "The TreeView source must have screen coordinates").not.toBeNull();
    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2 + 16,
      sourceBox!.y + sourceBox!.height / 2,
      { steps: 8 },
    );
    const started = await expect
      .poll(async () => (await readDragProbe(page)).some((event) => event.type === "dragstart"), {
        message: "VS Code must start the native TreeView drag gesture",
        timeout: 1_500,
      })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (started) return { sourceBox: sourceBox!, failedAttempts };
    failedAttempts.push({ sourceBox: sourceBox!, events: await readDragProbe(page) });
    await page.mouse.up();
  }
  throw new Error(
    `VS Code did not start the TreeView drag after 3 bounded gestures: ${JSON.stringify(failedAttempts)}`,
  );
}
