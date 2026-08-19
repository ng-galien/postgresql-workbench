import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const cockpit = vi.hoisted(() => ({
  receive: vi.fn(),
  session: null,
  exploration: { nodes: {}, edges: {}, neighborhoods: {}, focusIdentity: null },
  preview: null,
  error: "The Cockpit Connexion changed. Open its graph again.",
  radius: { incoming: 1, outgoing: 1 },
  reveal: vi.fn(),
  undoExpansion: vi.fn(),
  redoExpansion: vi.fn(),
  dismissPreview: vi.fn(),
}));

vi.mock("../vscodeApi.js", () => ({
  post: vi.fn(),
  subscribeToHost: () => () => {},
}));
vi.mock("../graph/store.js", () => ({
  useCockpitStore: (selector: (state: typeof cockpit) => unknown) => selector(cockpit),
}));

import { App } from "./App.js";

describe("Workbench graph cockpit shell", () => {
  it("renders the database-context invalidation instead of a loading placeholder", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("cockpit-error");
    expect(html).toContain("The Cockpit Connexion changed");
    expect(html).not.toContain("Opening PostgreSQL cockpit");
  });
});
