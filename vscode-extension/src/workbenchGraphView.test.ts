import { beforeEach, describe, expect, it, vi } from "vitest";

const panel = vi.hoisted(() => ({
  visible: false,
  post: vi.fn(),
}));

vi.mock("vscode", () => ({}));
vi.mock("./workbenchGraph/panel.js", () => ({
  WorkbenchGraphPanel: class {
    get current(): object {
      return {};
    }
    get visible(): boolean {
      return panel.visible;
    }
    post = panel.post;
    dispose(): void {}
  },
}));

import { WorkbenchGraphView } from "./workbenchGraphView.js";

function graphView(): WorkbenchGraphView {
  return new WorkbenchGraphView({
    extensionUri: {} as never,
    index: { indexedSymbols: [] } as never,
    openDefinition: async () => undefined,
    showActions: async () => undefined,
  });
}

beforeEach(() => {
  panel.post.mockReset().mockResolvedValue(true);
});

describe("Workbench graph database context invalidation", () => {
  it.each([true, false])("invalidates retained webview state when visible is %s", (visible) => {
    panel.visible = visible;
    const view = graphView();

    view.invalidateDatabaseContext();

    expect(panel.post).toHaveBeenCalledWith({
      type: "databaseContextInvalidated",
      message: "The active PostgreSQL database context changed. Open the active graph again.",
    });
    expect(view.currentModel).toBeUndefined();
    expect(view.currentScope).toBeUndefined();
    view.dispose();
  });
});
