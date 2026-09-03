import { describe, expect, it } from "vitest";
import {
  VSCODE_APPEARANCE_THEME_ROLES,
  VSCODE_DEFAULT_THEME_ROLES,
  vscodeThemeOverrides,
} from "./vscodeTheme.js";

describe("vscodeThemeOverrides", () => {
  it("projects every VS Code webview appearance onto the core color-scheme role", () => {
    const css = vscodeThemeOverrides();

    expect(VSCODE_APPEARANCE_THEME_ROLES).toEqual(["color-scheme"]);
    expect(VSCODE_DEFAULT_THEME_ROLES).not.toContain("color-scheme");
    expect(css).toContain("body.vscode-light { --pgw-color-scheme: light; }");
    expect(css).toContain("body.vscode-dark { --pgw-color-scheme: dark; }");
    expect(css).toContain("body.vscode-high-contrast { --pgw-color-scheme: high-contrast-dark; }");
    expect(css).toContain(
      "body.vscode-high-contrast-light { --pgw-color-scheme: high-contrast-light; }",
    );
  });

  it("does not project document-only body classes into a renderer shadow root", () => {
    expect(vscodeThemeOverrides(":host")).not.toContain("body.vscode-");
  });
});
