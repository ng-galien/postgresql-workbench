import type { Client } from "pg";
import { countLabel } from "../countLabel.js";
import {
  type DataViewChangeHandle,
  type DataViewEdit,
  type DataViewEditability,
  type DataViewRowInsertion,
  type DataViewRowRemoval,
  dataViewRowKey,
  dataViewWritableTable,
  describeDeleteConsequences,
  sameDataViewRow,
} from "./dataView.js";
import { READ_ONLY_REASONS, reasonAgainstWriting } from "./editability.js";
import type { HiddenColumns } from "./hiddenColumns.js";
import { buildRowDeletes, buildRowInserts, buildRowUpdates } from "./updates.js";

/**
 * What a surface showing a Data View must be able to do for changes to reach PostgreSQL. Each
 * surface answers these its own way — the Extension Host through VS Code, the composition shell
 * through its own connection and its own message bridge — and nothing about writing is written
 * twice: the sequence below is the only one there is.
 */
export interface DataViewWriteHost {
  /** A connection to write through. It is closed once the changes have been applied. */
  openClient(): Promise<Client>;
  /** Tells the reader what happened, in whatever way this surface has to say it. */
  notify(message: string, severity: "info" | "error"): void;
  /** The held changes moved: whatever shows them must be told. */
  changed(): void;
  /** Re-reads the rows once the database has taken the changes. */
  reload(): Promise<void>;
  /** How the connection is named to a reader. */
  connectionName(): string;
}

/**
 * One move a reader makes on what is waiting to be written.
 *
 * Six messages carry them, and they are named together here rather than one by one in the surfaces
 * that receive them: a surface hands anything in this union to `PendingEdits.move` without deciding
 * what any single one of them means, so a seventh move is added once instead of once per surface.
 */
export type DataViewMove =
  | { type: "data-view/edit"; edit: DataViewEdit }
  /**
   * Adds a row to fill in; it exists only in the grid until the changes are applied. `values`
   * arrives already filled when a pasted line fell past the last loaded row.
   */
  | { type: "data-view/add-row"; values?: Record<string, string | null>; above?: number }
  /** Takes away every row of the selection, by identity. */
  | { type: "data-view/remove-rows"; rows: DataViewRowRemoval[] }
  /** Takes back a row that was added but never written; the same move as discarding its change. */
  | { type: "data-view/drop-row"; localId: string }
  /**
   * Fills columns of an added row; a paste arrives as one message, not one per column. A column a
   * reader gives NULL is inserted as NULL; one named in `unset` is left out of the INSERT, so the
   * database gives it whatever it would have given — a DEFAULT, a sequence, an identity.
   */
  | {
      type: "data-view/fill-row";
      localId: string;
      values: Record<string, string | null>;
      unset?: readonly string[];
    }
  /** Takes one change back out of what is waiting, leaving every other one held. */
  | { type: "data-view/discard-change"; change: DataViewChangeHandle };

/**
 * Every move, one entry each. It is a record over the union rather than a list of strings so that a
 * seventh move cannot be added without being named here: leaving it out is a compile error, and a
 * move a surface routes by asking this question is a move no surface has to learn about.
 */
const DATA_VIEW_MOVES: Readonly<Record<DataViewMove["type"], true>> = {
  "data-view/edit": true,
  "data-view/add-row": true,
  "data-view/remove-rows": true,
  "data-view/drop-row": true,
  "data-view/fill-row": true,
  "data-view/discard-change": true,
};

/** Whether a request moves what is waiting, rather than reading the rows or rewriting the query. */
export function isDataViewMove<T extends { type: string }>(
  request: T,
): request is T & DataViewMove {
  return Object.hasOwn(DATA_VIEW_MOVES, request.type);
}

/** How a move is named to a surface that holds one undo entry per move. */
export function dataViewMoveLabel(move: DataViewMove): string {
  switch (move.type) {
    case "data-view/edit":
      return `Edit ${move.edit.column}`;
    case "data-view/add-row":
      return "Add row";
    case "data-view/remove-rows":
      return "Delete rows";
    case "data-view/drop-row":
      return "Take back row";
    case "data-view/fill-row":
      return "Fill row";
    case "data-view/discard-change":
      return "Discard change";
  }
}

/**
 * What a surface must be able to do when what is waiting has moved. A surface that counts a move
 * as an edit of its own document says so through `remember`; one without an undo stack leaves it
 * out, and the move is otherwise the same move.
 */
export interface DataViewMoveHost {
  /** Tells the reader what happened, in whatever way this surface has to say it. */
  notify(message: string, severity: "info" | "error"): void;
  /** The held changes moved: whatever shows them must be told. */
  changed(): void;
  /** The way back to what was held before this move, and the way forward to it again. */
  remember?(label: string, undo: () => void, redo: () => void): void;
}

/** What a move is decided against, and what it is answered to. */
export interface DataViewMoveContext {
  editability: DataViewEditability;
  /** Adding a row brings back the columns it cannot go without. */
  hidden: HiddenColumns;
  host: DataViewMoveHost;
}

/**
 * What a move did. It was refused and nothing happened; or it was allowed and found nothing to do,
 * which is not a change to remember; or it moved, and may drag consequences a reader should hear.
 */
type MoveOutcome =
  | { held: false; reason: string }
  | { held: true; moved: boolean; consequences?: string[] };

/** Local, unapplied cell edits of a Data View, and their atomic application. */
/** Which cell an edit is held against: one row of one table, and one column of it. */
type EditPlace = Pick<DataViewEdit, "tableOid" | "key" | "ordinal">;

export class PendingEdits {
  private items: DataViewEdit[] = [];
  private removals: DataViewRowRemoval[] = [];
  private insertions: DataViewRowInsertion[] = [];
  private added = 0;
  private writing = false;

  get list(): readonly DataViewEdit[] {
    return this.items;
  }

  get removedRows(): readonly DataViewRowRemoval[] {
    return this.removals;
  }

  get addedRows(): readonly DataViewRowInsertion[] {
    return this.insertions;
  }

  get size(): number {
    return this.items.length + this.removals.length + this.insertions.length;
  }

  /** True while the changes are being written: nothing may be held or discarded meanwhile. */
  get applying(): boolean {
    return this.writing;
  }

  /**
   * The one door every move a reader makes goes through, so that what is true of one move is true
   * of all six: a write under way refuses it, the refusal is worded once and said once, a move that
   * found nothing to do leaves nothing behind, adding a row brings back the columns it cannot go
   * without, and whatever shows the held changes is told afterwards rather than by each caller in
   * its own order. A deletion says what it drags along as the row is taken, not when the write fails.
   *
   * A write in flight used to refuse the cell edits alone, because that was the only move that
   * asked. The others were held, and then dropped without a word when the transaction that never
   * carried them cleared what was waiting: the reader was told their changes had been applied, and
   * the row they had just added was gone.
   */
  move(move: DataViewMove, context: DataViewMoveContext): void {
    if (this.writing) {
      context.host.notify(READ_ONLY_REASONS.applying, "info");
      return;
    }
    const before = this.snapshot();
    const outcome = this.perform(move, context.editability);
    if (!outcome.held) {
      context.host.notify(outcome.reason, "info");
      return;
    }
    if (!outcome.moved) return;
    if (move.type === "data-view/add-row") context.hidden.revealRequired(context.editability);
    const after = this.snapshot();
    const replay = (restore: () => void) => () => {
      restore();
      context.host.changed();
    };
    context.host.remember?.(dataViewMoveLabel(move), replay(before), replay(after));
    context.host.changed();
    const consequences = outcome.consequences ?? [];
    if (consequences.length > 0) context.host.notify(consequences.join(" "), "info");
  }

  /**
   * What each move does to what is waiting. Reached only through `move`, and only once its guard
   * has passed: nothing here asks again whether a write is under way.
   */
  private perform(move: DataViewMove, editability: DataViewEditability): MoveOutcome {
    switch (move.type) {
      case "data-view/edit":
        return this.record(move.edit, editability);
      case "data-view/add-row":
        return this.addRow(editability, move.values, move.above);
      case "data-view/remove-rows":
        return this.removeRows(move.rows, editability);
      case "data-view/drop-row":
        return { held: true, moved: this.discard({ kind: "insert", localId: move.localId }) };
      case "data-view/fill-row":
        return { held: true, moved: this.fillRow(move.localId, move.values, move.unset) };
      case "data-view/discard-change":
        return { held: true, moved: this.discard(move.change) };
    }
  }

  /**
   * Holds one cell edit, or says why it cannot be held. The column policy decides — a generated
   * column, a table without a key — and it decides the same on every surface.
   *
   * A row already provisioned to go holds nothing to change. Taking one away drops the edits it
   * held; letting an edit land on it afterwards would write an UPDATE the DELETE before it has left
   * nothing for — the guard would find no row, and the whole transaction would roll back.
   */
  private record(edit: DataViewEdit, editability: DataViewEditability): MoveOutcome {
    const refused = reasonAgainstWriting(editability.columns[edit.ordinal], this.isRemoved(edit));
    if (refused) return { held: false, reason: refused };
    this.set(edit);
    return { held: true, moved: true };
  }

  /**
   * Writes every held change in one transaction, then re-reads the rows. The database is left
   * untouched on any failure, and the changes stay held so they can be looked at and tried again.
   * The reader is told either way; the failure is raised again on top, because a surface with a
   * save of its own must not report success over a write that did not happen.
   */
  async apply(host: DataViewWriteHost, editability: DataViewEditability): Promise<void> {
    if (this.size === 0 || this.writing) return;
    this.writing = true;
    host.changed();
    let client: Client | undefined;
    try {
      client = await host.openClient();
      const applied = await this.applyWith(client, editability);
      this.writing = false;
      host.notify(`${countLabel(applied, "change")} applied to ${host.connectionName()}.`, "info");
      await host.reload();
    } catch (error) {
      this.writing = false;
      host.changed();
      host.notify(
        `The changes were not applied: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      throw error;
    } finally {
      await client?.end().catch(() => {});
    }
  }

  /** Stores one cell edit. An edit that puts the original value back is not a change at all. */
  private set(edit: DataViewEdit): void {
    const index = this.indexOfEdit(edit);
    const restoresOriginal = !edit.toDefault && edit.value === edit.original;
    if (index >= 0) {
      if (restoresOriginal) this.items.splice(index, 1);
      else this.items[index] = edit;
    } else if (!restoresOriginal) {
      this.items.push(edit);
    }
  }

  /** Where the edit of this row and this column is held, or -1. The one way of asking. */
  private indexOfEdit(place: EditPlace): number {
    return this.items.findIndex(
      (candidate) => sameDataViewRow(candidate, place) && candidate.ordinal === place.ordinal,
    );
  }

  /** Whether this row is one the reader took away. */
  private isRemoved(row: DataViewRowRemoval): boolean {
    const key = dataViewRowKey(row);
    return this.removals.some((candidate) => dataViewRowKey(candidate) === key);
  }

  /**
   * Takes a whole row away, or puts it back if it was already taken — the same gesture undoes
   * itself. Cell edits held on that row go with it: there is nothing to update in a row that is
   * about to be deleted. Answers with what the deletion drags along, so a reader hears it now
   * rather than when the write fails.
   */
  private removeRows(
    rows: readonly DataViewRowRemoval[],
    editability: DataViewEditability,
  ): MoveOutcome {
    const table = dataViewWritableTable(editability);
    if ("reason" in table)
      return { held: false, reason: `Rows can only be taken away ${table.reason}` };
    if (rows.length === 0) return { held: true, moved: false };
    const keys = new Set(rows.map((row) => dataViewRowKey(row)));
    if (rows.every((row) => this.isRemoved(row))) {
      this.removals = this.removals.filter((row) => !keys.has(dataViewRowKey(row)));
      return { held: true, moved: true };
    }
    this.items = this.items.filter((edit) => !keys.has(dataViewRowKey(edit)));
    for (const row of rows) {
      if (!this.isRemoved(row)) this.removals.push(row);
    }
    return { held: true, moved: true, consequences: describeDeleteConsequences(table) };
  }

  /**
   * Adds an empty row to fill in, or says why it cannot be added. Rows go into one table at a
   * time: there is nowhere to put them without one, and no way to choose between two — the same
   * rule for every surface, worded once.
   *
   * They are held in the order they are shown, so the one just added is the one just under the
   * reader's eye: last among the rows waiting over the same loaded row, and over every row below it.
   */
  private addRow(
    editability: DataViewEditability,
    values: Record<string, string | null> = {},
    above = 0,
  ): MoveOutcome {
    const table = dataViewWritableTable(editability);
    if ("reason" in table) return { held: false, reason: `Rows can only be added ${table.reason}` };
    this.added += 1;
    const at = this.insertions.findIndex((insertion) => insertion.above > above);
    const row = { tableOid: table.tableOid, localId: `new-${this.added}`, values, above };
    if (at < 0) this.insertions.push(row);
    else this.insertions.splice(at, 0, row);
    return { held: true, moved: true };
  }

  /**
   * Fills columns of a row being added. A cell of one holds one of three things, and they are not
   * the same row in the database: a value, an explicit NULL, or nothing at all. Only the third is
   * left out of the INSERT, which is what makes the column take the default the table gives it.
   *
   * The row is replaced rather than written into: what a snapshot captured must not change under
   * it later.
   */
  private fillRow(
    localId: string,
    values: Record<string, string | null>,
    unset: readonly string[] | undefined = [],
  ): boolean {
    const at = this.insertions.findIndex((candidate) => candidate.localId === localId);
    const row = this.insertions[at];
    if (!row) return false;
    const next = { ...row.values, ...values };
    for (const column of unset) delete next[column];
    this.insertions[at] = { ...row, values: next };
    return true;
  }

  /**
   * Takes one change back out of what is waiting, whichever kind it is. A reader who reads the list
   * before committing to it should be able to change their mind about one line of it without
   * discarding the eight others, and taking back a row they had added is that same move on the
   * change that row is. Answers whether there was such a change to take out.
   */
  private discard(change: DataViewChangeHandle): boolean {
    if (change.kind === "insert") {
      const before = this.insertions.length;
      this.insertions = this.insertions.filter((row) => row.localId !== change.localId);
      return this.insertions.length !== before;
    }
    if (change.kind === "delete") {
      if (!this.isRemoved(change)) return false;
      const key = dataViewRowKey(change);
      this.removals = this.removals.filter((row) => dataViewRowKey(row) !== key);
      return true;
    }
    const index = this.indexOfEdit(change);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  /**
   * Everything held right now, as the way back to it. A host that counts a move in what is waiting
   * as an edit of its document needs an undo for each one, and there are six ways to move: asking
   * each of them for its own inverse is six chances to get one wrong. Every row held here is
   * replaced rather than written into, so remembering the three lists is remembering three arrays —
   * an undo held for the life of a tab shares its rows with the others rather than copying them.
   */
  private snapshot(): () => void {
    const items = [...this.items];
    const removals = [...this.removals];
    const insertions = [...this.insertions];
    return () => {
      this.items = [...items];
      this.removals = [...removals];
      this.insertions = [...insertions];
    };
  }

  clear(): void {
    this.items = [];
    this.removals = [];
    this.insertions = [];
  }

  /**
   * Lets go of every change whose table the query no longer writes to, and says so in a sentence
   * a surface can show as it likes. A change is held against a table; once the reader has
   * composed that table away there is nowhere to write it, and keeping it only fails later with
   * a puzzling message.
   */
  forget(editability: DataViewEditability): string | undefined {
    const writable = new Set(editability.tables.map((table) => table.tableOid));
    const before = this.size;
    this.items = this.items.filter((edit) => writable.has(edit.tableOid));
    this.removals = this.removals.filter((removal) => writable.has(removal.tableOid));
    this.insertions = this.insertions.filter((row) => writable.has(row.tableOid));
    const forgotten = before - this.size;
    if (forgotten === 0) return undefined;
    return `${countLabel(forgotten, "change")} let go: the query no longer writes to the table ${
      forgotten === 1 ? "it was" : "they were"
    } held against.`;
  }

  /**
   * Applies every edit in one transaction on the given client and clears them; throws with the
   * database unchanged (ROLLBACK) when a row is stale, gone, or ambiguous.
   *
   * Rows taken away go first — one of them has no cell left to update — then the cells of the rows
   * that stay, then the rows being added, which nothing else can refer to yet.
   */
  async applyWith(client: Client, editability: DataViewEditability): Promise<number> {
    const statements = [
      ...buildRowDeletes(this.removals, editability),
      ...buildRowUpdates(this.items, editability),
      ...buildRowInserts(this.insertions, editability),
    ];
    await client.query("BEGIN");
    try {
      for (const statement of statements) {
        const result = await client.query(statement.text, statement.values);
        if (result.rowCount !== 1) {
          throw new Error(
            result.rowCount === 0
              ? `${statement.target} changed or disappeared since it was loaded. Nothing was applied; refresh and edit again.`
              : `${statement.target} matched ${result.rowCount} rows. Nothing was applied.`,
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    const applied = statements.length;
    this.clear();
    return applied;
  }
}
