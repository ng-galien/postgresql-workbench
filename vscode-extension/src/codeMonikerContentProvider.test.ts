import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  close: vi.fn(),
  groups: [] as Array<{ tabs: unknown[] }>,
  onDidChangeTabs: undefined as (() => void) | undefined,
}));

vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly callback = () => {}) {}
    dispose() {
      this.callback();
    }
  },
  EventEmitter: class {
    readonly event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  TabInputText: class {
    constructor(readonly uri: { scheme: string; toString(): string }) {}
  },
  window: {
    tabGroups: {
      get all() {
        return vscodeState.groups;
      },
      close: vscodeState.close,
      onDidChangeTabs(listener: () => void) {
        vscodeState.onDidChangeTabs = listener;
        return { dispose() {} };
      },
    },
  },
}));

import {
  CodeMonikerContentProvider,
  closeUnavailableCodeMonikerTabs,
} from "./codeMonikerContentProvider.js";

describe("stale Code Moniker source tabs", () => {
  beforeEach(() => {
    vscodeState.close.mockReset().mockResolvedValue(true);
    vscodeState.groups = [];
    vscodeState.onDidChangeTabs = undefined;
  });

  it("closes clean virtual sources that the new session cannot resolve", async () => {
    const stale = await tab("code+moniker", "code+moniker://stale", false);
    const available = await tab("code+moniker", "code+moniker://available", false);
    const regular = await tab("file", "file:///workspace/query.sql", false);
    vscodeState.groups = [{ tabs: [stale, available, regular] }];

    await closeUnavailableCodeMonikerTabs((uri) => uri.toString() === "code+moniker://available");

    expect(vscodeState.close).toHaveBeenCalledWith([stale], true);
  });

  it("preserves dirty virtual sources even when the index is unavailable", async () => {
    const dirty = await tab("code+moniker", "code+moniker://edited", true);
    vscodeState.groups = [{ tabs: [dirty] }];

    await closeUnavailableCodeMonikerTabs(() => false);

    expect(vscodeState.close).not.toHaveBeenCalled();
  });

  it("runs another cleanup pass when tabs change during an active reconciliation", async () => {
    let releaseFirstClose = () => {};
    vscodeState.close.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirstClose = () => resolve(true);
        }),
    );
    const first = await tab("code+moniker", "code+moniker://first", false);
    const second = await tab("code+moniker", "code+moniker://second", false);
    vscodeState.groups = [{ tabs: [first] }];
    const provider = new CodeMonikerContentProvider(
      {
        onServerChanged: () => ({ dispose() {} }),
      } as never,
      {
        onDidChangeState: () => ({ dispose() {} }),
        sourceDescriptorForDocumentUri: () => undefined,
      } as never,
    );
    await vi.waitFor(() => expect(vscodeState.close).toHaveBeenCalledTimes(1));

    vscodeState.groups = [{ tabs: [second] }];
    vscodeState.onDidChangeTabs?.();
    releaseFirstClose();

    await vi.waitFor(() => expect(vscodeState.close).toHaveBeenCalledTimes(2));
    expect(vscodeState.close).toHaveBeenLastCalledWith([second], true);
    provider.dispose();
  });
});

async function tab(scheme: string, value: string, isDirty: boolean) {
  const { TabInputText } = await import("vscode");
  return {
    isDirty,
    input: new TabInputText({ scheme, toString: () => value } as never),
  };
}
