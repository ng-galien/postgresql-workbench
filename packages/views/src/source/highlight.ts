/**
 * PostgreSQL source as the views hold it: numbered lines of pieces, each piece carrying at most
 * the class the language server's stream gave it.
 *
 * There used to be a second grammar here — Shiki over a TextMate file read out of the VS Code
 * extension's directory — colouring under the names. It read the same text a second time, by rules
 * with no provenance from PostgreSQL's own grammar, and it disagreed with the parse where the
 * grammar is subtle: `SELECT p.name` painted the column as a keyword, because to a word-matcher it
 * is one. The server now streams what each piece is beside what each name means, from the one
 * parse; a view that computed its own reading would be the drift the single path exists to end.
 */

export interface PostgresSourceToken {
  text: string;
  offset: number;
  /** Set when the stream named this piece: the class its kind is painted with. */
  className?: string;
}

export interface PostgresSourceLine {
  number: number;
  tokens: PostgresSourceToken[];
}

export interface HighlightedPostgresSource {
  lines: PostgresSourceLine[];
}

/** A text as the source views count it: one entry per line, numbered from one. */
export function postgresSourceLines(text: string): { number: number; text: string }[] {
  return text.split("\n").map((line, index) => ({ number: index + 1, text: line }));
}

/** The lines as they stand, one piece each, for the stream's names to be laid over. */
export function plainPostgresSource(
  lines: ReadonlyArray<{ number: number; text: string }>,
): HighlightedPostgresSource {
  return {
    lines: lines.map((line) => ({
      number: line.number,
      tokens: line.text ? [{ text: line.text, offset: 0 }] : [],
    })),
  };
}
