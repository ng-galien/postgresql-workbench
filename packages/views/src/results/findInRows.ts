/** Where a match sits: the row as it is shown, and the column as it is shown. */
export interface RowMatch {
  row: number;
  column: number;
}

/**
 * Every cell holding what is being looked for, in reading order — left to right, top to bottom.
 *
 * It matches against what the grid draws rather than against what the database holds, so a pending
 * edit is found by its new value and a row waiting to be added is found by what it has been filled
 * with. What a reader sees is what a reader can find.
 *
 * Case is ignored: a reader looking for a city does not know how the column spells it.
 */
export function matchingCells(
  rows: readonly (readonly (string | null)[])[],
  looking: string,
): RowMatch[] {
  const needle = looking.toLocaleLowerCase();
  if (needle === "") return [];
  const found: RowMatch[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, column) => {
      if (value?.toLocaleLowerCase().includes(needle)) {
        found.push({ row: rowIndex, column });
      }
    });
  });
  return found;
}

/**
 * Which match to go to from where the reader is. Going forwards lands on the first match past the
 * cursor, backwards on the last one before it, and either wraps round — a reader who reaches the
 * end of a result and presses again means "keep going", not "stop".
 *
 * The cursor itself is not a match to land on twice: from a match, forwards means the next one.
 */
export function matchFrom(
  matches: readonly RowMatch[],
  at: RowMatch,
  direction: 1 | -1,
): number | undefined {
  if (matches.length === 0) return undefined;
  const past = (match: RowMatch) =>
    match.row > at.row || (match.row === at.row && match.column > at.column);
  const before = (match: RowMatch) =>
    match.row < at.row || (match.row === at.row && match.column < at.column);
  if (direction === 1) {
    const next = matches.findIndex(past);
    return next === -1 ? 0 : next;
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match && before(match)) return index;
  }
  return matches.length - 1;
}
