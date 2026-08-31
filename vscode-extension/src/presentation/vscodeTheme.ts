import type {
  WorkbenchColorRole,
  WorkbenchThemeRole,
} from "../../../packages/presentation/src/roles.js";

/**
 * VS Code's projection onto the product theme vocabulary.
 *
 * The product owns the roles and their defaults. This adapter only says which host token may
 * override each role; the nested product fallback keeps the default valid when a VS Code theme
 * does not define that token.
 */
export const VSCODE_THEME_ROLE_PROJECTIONS = {
  "ui-font-family": "font-family",
  "ui-font-size": "font-size",
  "code-font-family": "editor-font-family",
  "code-font-size": "editor-font-size",
  text: "foreground",
  "text-muted": "descriptionForeground",
  "text-disabled": "disabledForeground",
  icon: "icon-foreground",
  link: "textLink-foreground",
  error: "errorForeground",
  warning: "editorWarning-foreground",
  "warning-background": "editorWarning-background",
  focus: "focusBorder",
  divider: "panel-border",
  modified: "gitDecoration-modifiedResourceForeground",
  "canvas-background": "editor-background",
  "floating-background": "editorWidget-background",
  "floating-text": "editorWidget-foreground",
  "floating-border": "widget-border",
  "floating-shadow": "widget-shadow",
  "header-background": "editorGroupHeader-tabsBackground",
  "sidebar-background": "sideBar-background",
  "code-block-background": "textCodeBlock-background",
  "code-text": "editor-foreground",
  "code-line-number": "editorLineNumber-foreground",
  "code-selection-background": "editor-selectionBackground",
  "code-selection-text": "editor-selectionForeground",
  "find-match-background": "editor-findMatchBackground",
  "find-match-highlight-background": "editor-findMatchHighlightBackground",
  "action-background": "button-background",
  "action-text": "button-foreground",
  "action-hover-background": "button-hoverBackground",
  "action-border": "button-border",
  "secondary-action-background": "button-secondaryBackground",
  "secondary-action-text": "button-secondaryForeground",
  "secondary-action-hover-background": "button-secondaryHoverBackground",
  "field-background": "input-background",
  "field-text": "input-foreground",
  "field-border": "input-border",
  "field-placeholder": "input-placeholderForeground",
  "field-error-background": "inputValidation-errorBackground",
  "field-error-border": "inputValidation-errorBorder",
  "field-error-text": "inputValidation-errorForeground",
  "field-warning-background": "inputValidation-warningBackground",
  "field-pending-accent": "inputValidation-warningBorder",
  "select-background": "dropdown-background",
  "select-text": "dropdown-foreground",
  "select-border": "dropdown-border",
  "hover-background": "list-hoverBackground",
  "selection-background": "list-activeSelectionBackground",
  "selection-text": "list-activeSelectionForeground",
  "toolbar-hover-background": "toolbar-hoverBackground",
  "menu-background": "menu-background",
  "menu-text": "menu-foreground",
  "menu-border": "menu-border",
  "menu-selection-background": "menu-selectionBackground",
  "menu-selection-text": "menu-selectionForeground",
  "menu-separator": "menu-separatorBackground",
  "chooser-background": "quickInput-background",
  "chooser-selection-background": "quickInputList-focusBackground",
  "chooser-selection-text": "quickInputList-focusForeground",
  "suggestion-background": "editorSuggestWidget-background",
  "suggestion-border": "editorSuggestWidget-border",
  "suggestion-text": "editorSuggestWidget-foreground",
  "suggestion-selection-background": "editorSuggestWidget-selectedBackground",
  "suggestion-selection-text": "editorSuggestWidget-selectedForeground",
  "badge-background": "badge-background",
  "badge-text": "badge-foreground",
  scrollbar: "scrollbarSlider-background",
  "scrollbar-hover": "scrollbarSlider-hoverBackground",
  "scrollbar-active": "scrollbarSlider-activeBackground",
  "diff-inserted-background": "diffEditor-insertedTextBackground",
  "accent-blue": "charts-blue",
  // VS Code has no charts.cyan token; its interface-symbol colour is the closest host accent.
  "accent-cyan": "symbolIcon-interfaceForeground",
  "accent-green": "charts-green",
  "accent-orange": "charts-orange",
  "accent-purple": "charts-purple",
  "accent-red": "charts-red",
  "accent-yellow": "charts-yellow",
  // These are inspected data values, so the debug-expression family is closer than schema icons.
  "data-property": "debugTokenExpression-name",
  "data-string": "debugTokenExpression-string",
  "data-number": "debugTokenExpression-number",
  "data-literal": "debugTokenExpression-boolean",
  "syntax-schema": "descriptionForeground",
  "syntax-relation": "symbolIcon-classForeground",
  "syntax-binding": "charts-green",
  "syntax-column": "symbolIcon-fieldForeground",
  "syntax-routine": "symbolIcon-functionForeground",
  "syntax-parameter": "charts-yellow",
  "syntax-type": "symbolIcon-interfaceForeground",
  "syntax-keyword": "symbolIcon-keywordForeground",
  "syntax-string": "symbolIcon-stringForeground",
  "syntax-number": "symbolIcon-numberForeground",
  "syntax-comment": "descriptionForeground",
  "syntax-operator": "symbolIcon-operatorForeground",
  "syntax-punctuation": "editor-foreground",
} as const satisfies Partial<Record<WorkbenchThemeRole, string>>;

/** Roles whose product-owned default has no faithful VS Code token. */
export const VSCODE_DEFAULT_THEME_ROLES = [
  "shadow-low",
  "shadow-medium",
  "shadow-high",
] as const satisfies readonly WorkbenchThemeRole[];

/** Appearance roles VS Code exposes through webview body classes rather than colour tokens. */
export const VSCODE_APPEARANCE_THEME_ROLES = [
  "color-scheme",
] as const satisfies readonly WorkbenchThemeRole[];

export function vscodeThemeOverrides(selector: ":host" | ":root" = ":root"): string {
  const declarations = Object.entries(VSCODE_THEME_ROLE_PROJECTIONS).map(
    ([role, token]) => `  --pgw-${role}: var(--vscode-${token}, var(--pgw-default-${role}));`,
  );
  const appearance =
    selector === ":root"
      ? [
          "body.vscode-light { --pgw-color-scheme: light; }",
          "body.vscode-dark { --pgw-color-scheme: dark; }",
          "body.vscode-high-contrast { --pgw-color-scheme: high-contrast-dark; }",
          "body.vscode-high-contrast-light { --pgw-color-scheme: high-contrast-light; }",
        ].join("\n")
      : "";
  return `${selector} {\n${declarations.join("\n")}\n}\n${appearance}`;
}

const VSCODE_THEME_COLOURS = {
  "accent-blue": "charts.blue",
  "accent-cyan": "symbolIcon.interfaceForeground",
  "accent-green": "charts.green",
  "accent-orange": "charts.orange",
  "accent-purple": "charts.purple",
  "accent-red": "charts.red",
  "accent-yellow": "charts.yellow",
} as const satisfies Partial<Record<WorkbenchColorRole, string>>;

export function vscodeThemeColour(role: WorkbenchColorRole): string {
  return VSCODE_THEME_COLOURS[role as keyof typeof VSCODE_THEME_COLOURS] ?? "foreground";
}
