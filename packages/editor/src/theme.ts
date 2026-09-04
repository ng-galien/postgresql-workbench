import type { editor } from "@codingame/monaco-vscode-editor-api";
import type { WorkbenchColorRole } from "../../presentation/src/roles.js";
import { workbenchThemeVariable } from "../../presentation/src/roles.js";
import {
  SQL_SEMANTIC_TOKEN_TYPES,
  type SqlSemanticTokenType,
} from "../../sql/src/languageServer/legend.js";

/** Product meaning of every token the canonical SQL server can emit. */
export const SQL_TOKEN_THEME_ROLES = {
  variable: "syntax-binding",
  parameter: "syntax-parameter",
  type: "syntax-type",
  function: "syntax-routine",
  sqlSchema: "syntax-schema",
  sqlTable: "syntax-relation",
  sqlView: "syntax-relation",
  sqlCte: "syntax-relation",
  sqlAlias: "syntax-binding",
  sqlColumn: "syntax-column",
  sqlFunction: "syntax-routine",
  sqlProcedure: "syntax-routine",
  sqlParameter: "syntax-parameter",
  sqlType: "syntax-type",
  sqlWindow: "syntax-binding",
  keyword: "syntax-keyword",
  string: "syntax-string",
  number: "syntax-number",
  comment: "syntax-comment",
  operator: "syntax-operator",
  punctuation: "syntax-punctuation",
} as const satisfies Record<SqlSemanticTokenType, WorkbenchColorRole>;

export const WORKBENCH_MONACO_THEME = "postgresql-workbench";

export interface WorkbenchMonacoTheme {
  data: editor.IStandaloneThemeData;
  semanticTokenColors: Record<SqlSemanticTokenType, string>;
  fontFamily: string;
  fontSize: number;
}

/** Resolves host-overridable Workbench roles into the concrete values Monaco's canvas consumes. */
export function workbenchMonacoTheme(element: Element): WorkbenchMonacoTheme {
  const style = getComputedStyle(element);
  const value = (name: Parameters<typeof workbenchThemeVariable>[0]): string => {
    const resolved = style.getPropertyValue(workbenchThemeVariable(name)).trim();
    if (!resolved) throw new Error(`Missing Workbench theme role: ${name}`);
    return resolved;
  };
  const role = (name: WorkbenchColorRole): string => monacoColour(value(name), name);
  const semanticTokenColors = Object.fromEntries(
    SQL_SEMANTIC_TOKEN_TYPES.map((token) => [token, role(SQL_TOKEN_THEME_ROLES[token])]),
  ) as Record<SqlSemanticTokenType, string>;
  const fontSize = Number.parseFloat(value("code-font-size"));
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error("Invalid Workbench theme role: code-font-size");
  }
  const base = monacoThemeBase(value("color-scheme"));
  return {
    semanticTokenColors,
    fontFamily: value("code-font-family"),
    fontSize,
    data: {
      base,
      inherit: false,
      // Monaco's standalone theme service resolves semantic-token types through the same token
      // rules as its renderer. Generate those rules from the canonical LSP legend and the
      // host-overridable presentation roles; no editor-local lexer or colour table is involved.
      rules: SQL_SEMANTIC_TOKEN_TYPES.map((token) => ({
        token,
        foreground: semanticTokenColors[token],
      })),
      colors: {
        "editor.background": role("canvas-background"),
        "editor.foreground": role("code-text"),
        "editorLineNumber.foreground": role("code-line-number"),
        "editor.selectionBackground": role("code-selection-background"),
        "editor.selectionForeground": role("code-selection-text"),
        "editor.findMatchBackground": role("find-match-background"),
        "editor.findMatchHighlightBackground": role("find-match-highlight-background"),
        "editorWidget.background": role("floating-background"),
        "editorWidget.foreground": role("floating-text"),
        "editorWidget.border": role("floating-border"),
        "editorSuggestWidget.background": role("suggestion-background"),
        "editorSuggestWidget.border": role("suggestion-border"),
        "editorSuggestWidget.foreground": role("suggestion-text"),
        "editorSuggestWidget.selectedBackground": role("suggestion-selection-background"),
        "editorSuggestWidget.selectedForeground": role("suggestion-selection-text"),
        focusBorder: role("focus"),
        "scrollbarSlider.background": role("scrollbar"),
        "scrollbarSlider.hoverBackground": role("scrollbar-hover"),
        "scrollbarSlider.activeBackground": role("scrollbar-active"),
      },
    },
  };
}

/** Monaco's standalone theme API accepts hexadecimal colours, while VS Code may expose rgba(). */
function monacoColour(value: string, role: WorkbenchColorRole): string {
  const hexadecimal = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu)?.[1];
  if (hexadecimal) {
    const expanded =
      hexadecimal.length <= 4
        ? [...hexadecimal].map((component) => component.repeat(2)).join("")
        : hexadecimal;
    return `#${expanded.toLowerCase()}`;
  }

  const functional = value.match(/^rgba?\((.*)\)$/iu)?.[1];
  if (!functional) throw new Error(`Invalid Workbench colour role: ${role} (${value})`);

  const [channelsSource, slashAlpha] = functional.split(/\s*\/\s*/u);
  const components = channelsSource.includes(",")
    ? channelsSource.split(/\s*,\s*/u)
    : channelsSource.trim().split(/\s+/u);
  const legacyAlpha = components.length === 4 ? components.pop() : undefined;
  if (components.length !== 3 || (slashAlpha !== undefined && legacyAlpha !== undefined)) {
    throw new Error(`Invalid Workbench colour role: ${role} (${value})`);
  }

  const channels = components.map((component) => cssChannel(component));
  const alpha = cssAlpha(slashAlpha ?? legacyAlpha ?? "1");
  if (channels.some((component) => component === undefined) || alpha === undefined) {
    throw new Error(`Invalid Workbench colour role: ${role} (${value})`);
  }
  const hex = [...(channels as number[]), alpha]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("");
  return `#${alpha === 255 ? hex.slice(0, 6) : hex}`;
}

function cssChannel(value: string): number | undefined {
  const percentage = value.endsWith("%");
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return undefined;
  const channel = percentage ? (numeric / 100) * 255 : numeric;
  return Math.round(Math.min(255, Math.max(0, channel)));
}

function cssAlpha(value: string): number | undefined {
  const percentage = value.endsWith("%");
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return undefined;
  const alpha = percentage ? numeric / 100 : numeric;
  return Math.round(Math.min(1, Math.max(0, alpha)) * 255);
}

function monacoThemeBase(value: string): editor.BuiltinTheme {
  switch (value) {
    case "light":
      return "vs";
    case "dark":
      return "vs-dark";
    case "high-contrast-dark":
      return "hc-black";
    case "high-contrast-light":
      return "hc-light";
    default:
      throw new Error(`Invalid Workbench theme role: color-scheme (${value})`);
  }
}
