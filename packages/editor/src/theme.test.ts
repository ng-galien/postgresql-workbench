import { describe, expect, it, vi } from "vitest";
import { SQL_SEMANTIC_TOKEN_TYPES } from "../../sql/src/languageServer/legend.js";
import { SQL_TOKEN_THEME_ROLES, workbenchMonacoTheme } from "./theme.js";

describe("the Monaco projection of the Workbench theme", () => {
  it("assigns exactly one product role to every token in the canonical server legend", () => {
    expect(Object.keys(SQL_TOKEN_THEME_ROLES)).toEqual([...SQL_SEMANTIC_TOKEN_TYPES]);
  });

  it("takes Monaco appearance and metrics from required presentation roles", () => {
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({
        getPropertyValue(name: string) {
          if (name === "--pgw-color-scheme") return "high-contrast-light";
          if (name === "--pgw-code-font-size") return "14px";
          if (name === "--pgw-code-font-family") return "Workbench Mono";
          return "#abcdef";
        },
      })),
    );

    const theme = workbenchMonacoTheme({} as Element);

    expect(theme.data).toMatchObject({ base: "hc-light", inherit: false });
    expect(theme.data.rules).toEqual(
      SQL_SEMANTIC_TOKEN_TYPES.map((token) => ({ token, foreground: "#abcdef" })),
    );
    expect(theme.fontFamily).toBe("Workbench Mono");
    expect(theme.fontSize).toBe(14);
    vi.unstubAllGlobals();
  });

  it("converts functional CSS colours to the hexadecimal format Monaco accepts", () => {
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({
        getPropertyValue(name: string) {
          if (name === "--pgw-color-scheme") return "light";
          if (name === "--pgw-code-font-size") return "13px";
          if (name === "--pgw-code-font-family") return "Workbench Mono";
          if (name === "--pgw-scrollbar") return "rgba(121, 121, 121, 0.4)";
          return "rgb(12, 34, 56)";
        },
      })),
    );

    const theme = workbenchMonacoTheme({} as Element);

    expect(theme.data.colors["scrollbarSlider.background"]).toBe("#79797966");
    expect(theme.semanticTokenColors.keyword).toBe("#0c2238");
    vi.unstubAllGlobals();
  });

  it("fails closed when a required presentation role is absent", () => {
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({ getPropertyValue: () => "" })),
    );

    expect(() => workbenchMonacoTheme({} as Element)).toThrow(
      "Missing Workbench theme role: syntax-binding",
    );
    vi.unstubAllGlobals();
  });
});
