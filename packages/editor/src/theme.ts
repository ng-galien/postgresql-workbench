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
  const role = (name: WorkbenchColorRole): string => value(name);
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
