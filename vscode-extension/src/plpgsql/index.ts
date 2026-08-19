/**
 * PL/pgSQL routines inside VS Code: colouring a routine body, showing values while debugging,
 * and comparing a working copy with the deployed source. The analysis, the deployment check and
 * the comparison itself live in `packages/sql/src/routines`; this module only wires them to
 * VS Code. This file is the module's public surface.
 */
export { createRoutineComparisonHandler } from "./compareCommand.js";
export { PlpgsqlInlineValuesProvider } from "./inlineValues.js";
export {
  LEGEND,
  PlpgsqlSemanticTokensProvider,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from "./semanticTokens.js";
