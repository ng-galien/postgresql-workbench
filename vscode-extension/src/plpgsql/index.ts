/**
 * PL/pgSQL routine sources inside VS Code: recognizing the language, analyzing a routine body,
 * colouring it, showing values while debugging, deploying an edited routine, and comparing a
 * working copy with what the database holds. This file is the module's public surface for code
 * that runs inside VS Code; `documentLanguage.ts` and `compareSource.ts` are pure doors.
 */

export {
  isPostgresSqlLanguage,
  POSTGRES_SOURCE_LANGUAGE_IDS,
  postgresSourceLanguageId,
} from "../../../packages/sql/src/authoring/documentLanguage.js";
export { createRoutineComparisonHandler } from "./compareCommand.js";
export { validateManagedRoutineDeployment } from "./deployRoutine.js";
export { analyzePlpgsqlDocument } from "./documentAnalysis.js";
export { PlpgsqlInlineValuesProvider } from "./inlineValues.js";
export {
  LEGEND,
  PlpgsqlSemanticTokensProvider,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from "./semanticTokens.js";
