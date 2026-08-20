import { codicons } from "./codicons.js";
import iconButtonStyles from "./iconButton.css";
import gridStyles from "./styles.css";

/**
 * Every stylesheet a view that shows rows needs: the inlined codicon font, the grid, the icon
 * buttons. Built once — a notebook shows many outputs, and each carries the whole sheet, so what
 * only one view uses is that view's to carry.
 */
export const resultViewStyles = `${codicons}\n${gridStyles}\n${iconButtonStyles}`;
