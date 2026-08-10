import { beforeEach, describe, expect, it, vi } from "vitest";

const createWebviewPanel = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: string, ...parts: string[]) => [base, ...parts].join("/"),
  },
  ViewColumn: { Active: 1 },
  window: { createWebviewPanel },
}));

import { WorkbenchGraphPanel } from "./panel.js";

beforeEach(() => {
  createWebviewPanel.mockReset();
});

describe("WorkbenchGraphPanel", () => {
  it("sets a theme-aware SQL Cockpit icon on the editor tab", () => {
    const panel = {
      iconPath: undefined,
      onDidDispose: vi.fn(),
      reveal: vi.fn(),
      webview: {
        asWebviewUri: (uri: string) => uri,
        cspSource: "vscode-webview:",
        html: "",
        onDidReceiveMessage: vi.fn(),
      },
    };
    createWebviewPanel.mockReturnValue(panel);
    const host = new WorkbenchGraphPanel("/extension" as never, vi.fn(), vi.fn());

    host.ensure("demo");

    expect(createWebviewPanel).toHaveBeenCalledWith(
      "postgresql-workbench.graph",
      "demo",
      expect.anything(),
      expect.anything(),
    );
    expect(panel.iconPath).toEqual({
      light: "/extension/icons/sql-cockpit-light.svg",
      dark: "/extension/icons/sql-cockpit-dark.svg",
    });
  });
});
