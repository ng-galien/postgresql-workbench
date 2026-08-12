import type { Frame, Page } from "@playwright/test";

export interface DragProbeEvent {
  type: string;
  types: string[];
  target: string;
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
