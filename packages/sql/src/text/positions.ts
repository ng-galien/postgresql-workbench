/** A place in a text, counted the way a language server counts: zero-based line, then character. */
export interface TextPosition {
  line: number;
  character: number;
}

/**
 * Where an offset sits in a text. Offsets are how this codebase talks about SQL — a statement has
 * a start and an end, a caret is a number — and lines are how a language server and an editor talk
 * about it. Both directions live here so neither side has to count the other's way twice.
 *
 * The lines before the offset are counted, not materialised: what is wanted is one number, and a
 * caret near the end of a large document is asked about on every keystroke.
 */
export function positionAtOffset(text: string, offset: number): TextPosition {
  const bounded = Math.max(0, Math.min(text.length, offset));
  let line = 0;
  let lineStart = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < bounded; at = text.indexOf("\n", at + 1)) {
    line += 1;
    lineStart = at + 1;
  }
  return { line, character: bounded - lineStart };
}

/** Where a position sits in a text. A line past its end is its end; so is a character past a line. */
export function offsetAtPosition(text: string, position: TextPosition): number {
  let lineStart = 0;
  for (let line = 0; line < position.line; line += 1) {
    const next = text.indexOf("\n", lineStart);
    if (next === -1) return text.length;
    lineStart = next + 1;
  }
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(lineStart + Math.max(0, position.character), end);
}
