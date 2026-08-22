import { codiconGlyphs, codicons } from "./codicons.js";
import iconButtonStyles from "./iconButton.css";
import gridStyles from "./styles.css";

/**
 * Every stylesheet a view that shows rows needs: the inlined codicon font, the grid, the icon
 * buttons. Built once — a notebook shows many outputs, and each carries the whole sheet, so what
 * only one view uses is that view's to carry.
 */
export const resultViewStyles = `${codicons}\n${gridStyles}\n${iconButtonStyles}`;

/**
 * The same sheet for a view that renders inside a shadow root, which carries every rule but the
 * font. A font is registered by the document and by nothing else, so it goes there once through
 * `registerCodiconFont` rather than into every shadow root — a notebook draws one per output, and
 * the font is the largest thing in the sheet.
 */
export const resultViewStylesInShadowRoot = `${codiconGlyphs}\n${gridStyles}\n${iconButtonStyles}`;
