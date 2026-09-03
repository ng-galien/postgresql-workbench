import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SqlEditorSurfaceProps } from "../../../../editor/src/contracts.js";
import type { CockpitMessaging } from "../protocol.js";

const cockpit = vi.hoisted(() => ({
  receive: vi.fn(),
  session: null,
  exploration: { nodes: {}, edges: {}, neighborhoods: {}, focusIdentity: null },
  preview: null,
  error: "The Cockpit Connection changed. Open its graph again.",
  radius: { incoming: 1, outgoing: 1 },
  reveal: vi.fn(),
  undoExpansion: vi.fn(),
  redoExpansion: vi.fn(),
  dismissPreview: vi.fn(),
}));

vi.mock("../graph/store.js", () => ({
  useCockpitStore: (selector: (state: typeof cockpit) => unknown) => selector(cockpit),
}));

import { App } from "./App.js";

function StubEditor({ ariaLabel, text }: SqlEditorSurfaceProps) {
  return <section aria-label={ariaLabel}>{text}</section>;
}

const messaging: CockpitMessaging = {
  post: vi.fn(),
  subscribe: () => () => undefined,
};

describe("Workbench graph cockpit shell", () => {
  it("renders the database-context invalidation instead of a loading placeholder", () => {
    const html = renderToStaticMarkup(<App messaging={messaging} Editor={StubEditor} />);

    expect(html).toContain("cockpit-error");
    expect(html).toContain("The Cockpit Connection changed");
    expect(html).not.toContain("Opening PostgreSQL cockpit");
  });
});
