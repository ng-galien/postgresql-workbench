import codiconStyles from "@vscode/codicons/dist/codicon.css";
import codiconFont from "@vscode/codicons/dist/codicon.ttf";

/**
 * The rule that gives the browser the font itself, with the file embedded in it. A view cannot
 * fetch the font by the relative URL the published stylesheet uses, so it carries the bytes.
 */
export const codiconFontFace = `@font-face { font-family: "codicon"; src: url(${codiconFont}) format("truetype"); }`;

/** What each icon class draws, without the font: the rules, and nothing that loads anything. */
export const codiconGlyphs = codiconStyles.replace(/@font-face\s*\{[^}]*\}/u, "");

/**
 * The codicon stylesheet with its font embedded — for a view that puts its styles in the page.
 * A view that renders inside a shadow root must use `registerCodiconFont` instead: see there.
 */
export const codicons = `${codiconFontFace}\n${codiconGlyphs}`;

/**
 * Gives the page the codicon font, once, for a view that renders inside a shadow root.
 *
 * A font is registered by the document and by nothing else: an `@font-face` inside a shadow root
 * parses and is then ignored, so the family never exists and every icon draws as an empty box.
 * The glyph rules stay in the shadow root, where the view's styles belong; only the font comes out.
 */
export function registerCodiconFont(target: Document): void {
  const owner = target.head ?? target.documentElement;
  if (!owner || target.querySelector(`style[${CODICON_FONT_MARKER}]`)) return;
  const style = target.createElement("style");
  style.setAttribute(CODICON_FONT_MARKER, "");
  style.textContent = codiconFontFace;
  owner.append(style);
}

const CODICON_FONT_MARKER = "data-codicon-font";
