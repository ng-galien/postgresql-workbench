import type { SqlAuthoringSemanticToken } from "../languageServer/protocol.js";
import { TOKEN_MODIFIERS, TOKEN_TYPES } from "../text/plpgsqlTokenLegend.js";
import {
  findIdentifierColumns,
  type ParsedRoutine,
  type RoutineVariable,
} from "./documentAnalysis.js";

/**
 * What a PL/pgSQL routine body's own names are: its variables, its parameters, and the types it
 * declares them with.
 *
 * This is the answer, and it is plain: the routines have already been parsed, and what is left is
 * to say where each name appears. It lived inside a VS Code semantic tokens provider, which made it
 * unreachable from anywhere else — the language server asked the Extension Host for it and relayed
 * what came back, so a body opened outside VS Code was coloured by nobody. The parser is genuinely
 * the host's, because Code Moniker runs there; deciding what the parse means is not.
 */
export function plpgsqlSemanticTokens(
  text: string,
  routines: readonly ParsedRoutine[],
): SqlAuthoringSemanticToken[] {
  const lines = text.split("\n");
  const tokens: SqlAuthoringSemanticToken[] = [];
  for (const routine of routines) {
    if (routine.variables.length === 0) continue;
    const declarations = declarationTokens(lines, routine);
    const declared = new Set(declarations.map(placeOf));
    tokens.push(
      ...declarations,
      ...occurrenceTokens(lines, routine).filter((token) => !declared.has(placeOf(token))),
    );
  }
  return tokens.sort((a, b) => a.line - b.line || a.character - b.character);
}

/**
 * Where a token sits, so that no two are given the same place. A declaration line is a body line as
 * well, so a name written there was marked twice: once as the declaration it is, and once as a
 * plain use of itself. Two tokens over one range is a stream the protocol does not allow, and the
 * second silently took the first's modifiers away — which is why nothing ever looked declared.
 */
function placeOf(token: SqlAuthoringSemanticToken): string {
  return `${token.line}:${token.character}`;
}

/**
 * Where each variable is declared, and the type it is declared with. Parameters are declared in the
 * signature rather than in the body, so they have no declaration line to mark.
 */
function declarationTokens(
  lines: readonly string[],
  routine: ParsedRoutine,
): SqlAuthoringSemanticToken[] {
  const tokens: SqlAuthoringSemanticToken[] = [];
  for (const variable of routine.variables) {
    if (variable.isParam || variable.declareLine === 0) continue;
    const line = routine.bodyStartLine + variable.declareLine - 1;
    const text = lines[line];
    if (text === undefined) continue;
    for (const character of findIdentifierColumns(text, variable.name)) {
      tokens.push({
        line,
        character,
        length: variable.name.length,
        tokenType: typeIndex("variable"),
        tokenModifiers: declarationModifiers(variable),
      });
    }
    tokens.push(...typeTokens(text, line, variable));
  }
  return tokens;
}

/**
 * The type a variable is declared with. A qualified type is found by its last part, because that is
 * what stands as an identifier on the line — and it is that part which is marked: covering the
 * schema too would run the token past the name it was found by.
 */
function typeTokens(
  text: string,
  line: number,
  variable: RoutineVariable,
): SqlAuthoringSemanticToken[] {
  const declared = variable.typeName;
  if (!declared) return [];
  const name = declared.split(".").at(-1) ?? declared;
  return findIdentifierColumns(text, name).map((character) => ({
    line,
    character,
    length: name.length,
    tokenType: typeIndex("type"),
    tokenModifiers: 0,
  }));
}

/**
 * Every place the routine's own names are used in its body. A line that is wholly a comment names
 * nothing: a variable's name written in prose is prose.
 */
function occurrenceTokens(
  lines: readonly string[],
  routine: ParsedRoutine,
): SqlAuthoringSemanticToken[] {
  const tokens: SqlAuthoringSemanticToken[] = [];
  for (let line = routine.bodyStartLine; line <= routine.bodyEndLine; line += 1) {
    const text = lines[line];
    if (text === undefined || /^\s*--/u.test(text)) continue;
    for (const variable of routine.variables) {
      for (const character of findIdentifierColumns(text, variable.name)) {
        tokens.push({
          line,
          character,
          length: variable.name.length,
          tokenType: typeIndex(variable.isParam ? "parameter" : "variable"),
          tokenModifiers: 0,
        });
      }
    }
  }
  return tokens;
}

/** A declaration, and a constant is one that may not be written to again. */
function declarationModifiers(variable: RoutineVariable): number {
  const declaration = 1 << TOKEN_MODIFIERS.indexOf("declaration");
  return variable.isConst ? declaration | (1 << TOKEN_MODIFIERS.indexOf("readonly")) : declaration;
}

function typeIndex(type: (typeof TOKEN_TYPES)[number]): number {
  return TOKEN_TYPES.indexOf(type);
}
