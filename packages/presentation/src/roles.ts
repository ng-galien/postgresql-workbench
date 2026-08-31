/**
 * The public visual vocabulary of PostgreSQL Workbench.
 *
 * A view names the role a value plays; a theme says what that role looks like. Hosts may project
 * their own theme onto these roles, but neither a view nor an editor invents another palette.
 */
export const WORKBENCH_COLOR_ROLES = [
  "accent-blue",
  "accent-cyan",
  "accent-green",
  "accent-orange",
  "accent-purple",
  "accent-red",
  "accent-yellow",
  "action-background",
  "action-border",
  "action-hover-background",
  "action-text",
  "badge-background",
  "badge-text",
  "canvas-background",
  "chooser-background",
  "chooser-selection-background",
  "chooser-selection-text",
  "code-block-background",
  "code-line-number",
  "code-selection-background",
  "code-selection-text",
  "code-text",
  "data-literal",
  "data-number",
  "data-property",
  "data-string",
  "diff-inserted-background",
  "divider",
  "error",
  "field-background",
  "field-border",
  "field-error-background",
  "field-error-border",
  "field-error-text",
  "field-pending-accent",
  "field-placeholder",
  "field-text",
  "field-warning-background",
  "find-match-background",
  "find-match-highlight-background",
  "floating-background",
  "floating-border",
  "floating-shadow",
  "floating-text",
  "focus",
  "header-background",
  "hover-background",
  "icon",
  "link",
  "menu-background",
  "menu-border",
  "menu-selection-background",
  "menu-selection-text",
  "menu-separator",
  "menu-text",
  "modified",
  "scrollbar",
  "scrollbar-active",
  "scrollbar-hover",
  "secondary-action-background",
  "secondary-action-hover-background",
  "secondary-action-text",
  "select-background",
  "select-border",
  "select-text",
  "selection-background",
  "selection-text",
  "shadow-high",
  "shadow-low",
  "shadow-medium",
  "sidebar-background",
  "suggestion-background",
  "suggestion-border",
  "suggestion-selection-background",
  "suggestion-selection-text",
  "suggestion-text",
  "syntax-binding",
  "syntax-column",
  "syntax-comment",
  "syntax-keyword",
  "syntax-number",
  "syntax-operator",
  "syntax-parameter",
  "syntax-punctuation",
  "syntax-relation",
  "syntax-routine",
  "syntax-schema",
  "syntax-string",
  "syntax-type",
  "text",
  "text-disabled",
  "text-muted",
  "toolbar-hover-background",
  "warning",
  "warning-background",
] as const;

export const WORKBENCH_FONT_FAMILY_ROLES = ["code-font-family", "ui-font-family"] as const;
export const WORKBENCH_FONT_SIZE_ROLES = ["code-font-size", "ui-font-size"] as const;
export const WORKBENCH_APPEARANCE_ROLES = ["color-scheme"] as const;

export type WorkbenchColorRole = (typeof WORKBENCH_COLOR_ROLES)[number];
export type WorkbenchFontFamilyRole = (typeof WORKBENCH_FONT_FAMILY_ROLES)[number];
export type WorkbenchFontSizeRole = (typeof WORKBENCH_FONT_SIZE_ROLES)[number];
export type WorkbenchAppearanceRole = (typeof WORKBENCH_APPEARANCE_ROLES)[number];
export type WorkbenchThemeRole =
  | WorkbenchColorRole
  | WorkbenchFontFamilyRole
  | WorkbenchFontSizeRole
  | WorkbenchAppearanceRole;

export const WORKBENCH_THEME_ROLES: readonly WorkbenchThemeRole[] = [
  ...WORKBENCH_COLOR_ROLES,
  ...WORKBENCH_FONT_FAMILY_ROLES,
  ...WORKBENCH_FONT_SIZE_ROLES,
  ...WORKBENCH_APPEARANCE_ROLES,
];

export function workbenchThemeVariable(role: WorkbenchThemeRole): `--pgw-${WorkbenchThemeRole}` {
  return `--pgw-${role}`;
}
