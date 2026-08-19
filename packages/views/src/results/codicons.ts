import codiconStyles from "@vscode/codicons/dist/codicon.css";
import codiconFont from "@vscode/codicons/dist/codicon.ttf";

/**
 * The codicon stylesheet with its font embedded. A webview cannot fetch the font by the relative
 * URL the published stylesheet uses, so every view that shows an icon loads this instead.
 */
export const codicons = codiconStyles.replace(
  /@font-face\s*\{[^}]*\}/u,
  `@font-face { font-family: "codicon"; src: url(${codiconFont}) format("truetype"); }`,
);
