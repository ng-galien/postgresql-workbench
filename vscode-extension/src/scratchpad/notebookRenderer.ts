import {
  activate as activateWorkbenchRenderer,
  type RendererApi,
  type RendererContext,
} from "../../../packages/views/src/results/index.js";
import { vscodeThemeOverrides } from "../presentation/vscodeTheme.js";

/** VS Code's notebook entrypoint: compose its renderer with the host's theme projection. */
export function activate(context: RendererContext): RendererApi {
  return activateWorkbenchRenderer(context, vscodeThemeOverrides(":host"));
}
