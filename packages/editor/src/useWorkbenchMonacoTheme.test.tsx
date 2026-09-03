// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchMonacoTheme } from "./useWorkbenchMonacoTheme.js";

describe("live Monaco theme projection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reprojects the core roles when the host changes its theme class", async () => {
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({
        getPropertyValue(name: string) {
          if (name === "--pgw-color-scheme") {
            return document.body.classList.contains("vscode-light") ? "light" : "dark";
          }
          if (name === "--pgw-code-font-size") return "13px";
          if (name === "--pgw-code-font-family") return "Workbench Mono";
          return "#abcdef";
        },
      })),
    );
    document.body.className = "vscode-dark";
    const { result } = renderHook(() => useWorkbenchMonacoTheme(document.documentElement));
    expect(result.current.data.base).toBe("vs-dark");

    act(() => {
      document.body.className = "vscode-light";
    });

    await waitFor(() => expect(result.current.data.base).toBe("vs"));
  });
});
