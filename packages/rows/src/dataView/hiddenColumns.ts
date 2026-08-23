import { type DataViewEditability, withRequiredColumnsRevealed } from "./dataView.js";

/**
 * Which columns of a Data View the reader is not being shown.
 *
 * A column is named by its key — the table it comes from and its label — because two tables of one
 * join can both have a `name`, and hiding one must not hide the other. Every surface that leaves a
 * column out asks here, so what the grid draws, what a copy takes and what an export writes cannot
 * disagree about it.
 *
 * The keys of the loaded result arrive with it and are kept, so nothing has to derive them again:
 * a host that worked them out for itself is exactly how the labels came to be compared instead.
 *
 * It also remembers which columns it has seen: identity and relationship columns start hidden the
 * first time they appear — including when a JOIN brings new ones in — and keep whatever the reader
 * chose afterwards.
 */
export class HiddenColumns {
  private keys = new Set<string>();
  private technicalKeys: readonly string[] = [];
  /** Every column of the loaded result, in ordinal order, as the result itself named them. */
  private columnKeys: readonly string[] = [];
  private seen = new Set<string>();

  /** The hidden keys, as the state a host broadcasts carries them. */
  get list(): readonly string[] {
    return [...this.keys];
  }

  hide(column: string): void {
    this.keys.add(column);
  }

  /** One column, or every one of them when no column is named. */
  unhide(column?: string): void {
    if (column === undefined) this.keys.clear();
    else this.keys.delete(column);
  }

  /** The identity and relationship columns, together: the reader asked about the group. */
  hideTechnical(hidden: boolean): void {
    for (const key of this.technicalKeys) {
      if (hidden) this.keys.add(key);
      else this.keys.delete(key);
    }
  }

  /**
   * What a freshly loaded result changes. `hideKeyColumns` is the reader's setting: with it off,
   * nothing starts hidden, but which columns have been seen is still remembered — turning it on
   * later must not then hide columns they have been looking at all along.
   */
  afterLoad(
    opened: { technicalKeys: readonly string[]; columnKeys: readonly string[] },
    hideKeyColumns: boolean,
  ): void {
    this.technicalKeys = opened.technicalKeys;
    this.columnKeys = opened.columnKeys;
    if (hideKeyColumns) {
      for (const key of opened.technicalKeys) {
        if (!this.seen.has(key)) this.keys.add(key);
      }
    }
    for (const key of opened.columnKeys) this.seen.add(key);
  }

  /** A reader cannot fill in a column they cannot see, so adding a row brings back what it needs. */
  revealRequired(editability: DataViewEditability): void {
    this.keys = new Set(withRequiredColumnsRevealed(this.list, editability, this.columnKeys));
  }

  /** Back to showing everything, and to having seen nothing. */
  clear(): void {
    this.unhide();
    this.seen.clear();
  }

  /**
   * The ordinals the reader is being shown, in order — what a copy takes and what an export
   * writes. Asked here rather than worked out again by each surface: a column is named by its key,
   * and a surface comparing bare column labels instead once wrote hidden columns into the file
   * while the preview beside it left them out.
   */
  shownOrdinals(): number[] {
    return this.columnKeys.flatMap((key, ordinal) => (this.keys.has(key) ? [] : [ordinal]));
  }
}
