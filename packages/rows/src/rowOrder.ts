import type { DataViewRowInsertion } from "./dataView.js";

/**
 * The order the grid shows its rows in. A row the reader added sits just above the loaded row it
 * was added over, so the two kinds are interleaved rather than stacked, and one index counts
 * through both: that index is what a selection, a paste and the arrow keys all speak in.
 *
 * The insertions are expected in the order they are shown — the order the pending changes hold
 * them in — so nothing here has to sort.
 */
export interface RowOrder {
  /** How many rows are shown: the loaded ones and the ones waiting to be added. */
  count: number;
  /** Where the row added at this place in the insertions is shown. */
  ofAdded: (position: number) => number;
  /** Where this loaded row is shown. */
  ofLoaded: (loadedIndex: number) => number;
  /** Which row is shown at this place: one the reader added, or a loaded one. */
  at: (index: number) => { added: DataViewRowInsertion; position: number } | { loaded: number };
  /** How many added rows are shown above this loaded row, which is what a spacer has to cover. */
  addedAbove: (loadedIndex: number) => number;
}

export function rowOrder(added: readonly DataViewRowInsertion[], loadedCount: number): RowOrder {
  // Where each added row lands: its own place among the insertions, pushed down by every loaded
  // row above it. Computed once, because everything else reads it.
  const places = added.map((insertion, position) => insertion.above + position);
  const ofAdded = (position: number) => places[position] ?? 0;
  const addedAbove = (loadedIndex: number) =>
    added.reduce((total, insertion) => total + (insertion.above <= loadedIndex ? 1 : 0), 0);
  return {
    count: loadedCount + added.length,
    ofAdded,
    ofLoaded: (loadedIndex) => loadedIndex + addedAbove(loadedIndex),
    at: (index) => {
      const position = places.indexOf(index);
      const insertion = position < 0 ? undefined : added[position];
      if (insertion) return { added: insertion, position };
      const before = places.reduce((total, place) => total + (place < index ? 1 : 0), 0);
      return { loaded: index - before };
    },
    addedAbove,
  };
}
