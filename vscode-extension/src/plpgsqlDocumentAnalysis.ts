import {
  analyzePlpgsqlSource,
  type ParsedPlpgsqlRoutine,
  type PlpgsqlRoutineVariable,
} from "../../src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";

const analysisCache = new Map<string, { version: number; routines: ParsedPlpgsqlRoutine[] }>();

export interface DocumentLike {
  uri: { toString(): string };
  version: number;
  getText(): string;
}

export type RoutineVariable = PlpgsqlRoutineVariable;
export type ParsedRoutine = ParsedPlpgsqlRoutine;

export async function analyzePlpgsqlDocument(
  document: DocumentLike,
  parser: SyntaxParser,
): Promise<ParsedPlpgsqlRoutine[]> {
  const key = document.uri.toString();
  const cached = analysisCache.get(key);
  if (cached?.version === document.version) return cached.routines;

  const routines = await analyzePlpgsqlSource(document.getText(), parser);
  analysisCache.set(key, { version: document.version, routines });
  return routines;
}

export function findIdentifierColumns(line: string, word: string): number[] {
  const columns: number[] = [];
  if (!word) return columns;

  let from = 0;
  while (from < line.length) {
    const index = line.indexOf(word, from);
    if (index === -1) break;

    const before = index === 0 ? "" : line[index - 1];
    const after = index + word.length >= line.length ? "" : line[index + word.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      columns.push(index);
    }

    from = index + word.length;
  }

  return columns;
}

function isIdentifierChar(character: string): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}
