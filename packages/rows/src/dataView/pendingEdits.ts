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
import { READ_ONLY_REASONS } from "./editability.js";
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

/** Local, unapplied cell edits of a Data View, and their atomic application. */
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
   * Holds one cell edit, or says why it cannot be held. The column policy decides — a generated
   * column, a table without a key, a write already under way — and it decides the same on every
   * surface. Returns the edit that was replaced, which is what an undo needs to put back.
   */
  record(
    edit: DataViewEdit,
    editability: DataViewEditability,
  ): { held: true; previous?: DataViewEdit } | { held: false; reason: string } {
    const policy = editability.columns[edit.ordinal];
    if (this.writing) return { held: false, reason: READ_ONLY_REASONS.applying };
    if (!policy?.editable)
      return { held: false, reason: policy?.reason ?? "This column cannot be edited." };
    /*
     * A row already provisioned to go holds nothing to change. Taking one away drops the edits it
     * held; letting an edit land on it afterwards would write an UPDATE the DELETE before it has
     * left nothing for — the guard would find no row, and the whole transaction would roll back.
     */
    if (this.isRemoved(edit)) return { held: false, reason: READ_ONLY_REASONS.removed };
    const previous = this.set(edit);
    return previous ? { held: true, previous } : { held: true };
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

  /** Stores one cell edit; returns the edit it replaced. Reverting to the original drops it. */
  set(edit: DataViewEdit): DataViewEdit | undefined {
    const index = this.items.findIndex(
      (candidate) => sameDataViewRow(candidate, edit) && candidate.ordinal === edit.ordinal,
    );
    const previous = index >= 0 ? this.items[index] : undefined;
    const restoresOriginal = !edit.toDefault && edit.value === edit.original;
    if (index >= 0) {
      if (restoresOriginal) this.items.splice(index, 1);
      else this.items[index] = edit;
    } else if (!restoresOriginal) {
      this.items.push(edit);
    }
    return previous;
  }

  remove(edit: DataViewEdit): void {
    this.items = this.items.filter(
      (candidate) => !(sameDataViewRow(candidate, edit) && candidate.ordinal === edit.ordinal),
    );
  }

  /** Whether this row is one the reader took away. */
  isRemoved(row: DataViewRowRemoval): boolean {
    const key = dataViewRowKey(row);
    return this.removals.some((candidate) => dataViewRowKey(candidate) === key);
  }

  /**
   * Takes a whole row away, or puts it back if it was already taken. Cell edits held on that row
   * go with it: there is nothing to update in a row that is about to be deleted. Answers with
   * what the deletion drags along, so a reader hears it now rather than when the write fails.
   */
  removeRows(
    rows: readonly DataViewRowRemoval[],
    editability: DataViewEditability,
  ): { held: true; consequences: string[] } | { held: false; reason: string } {
    const table = dataViewWritableTable(editability);
    if ("reason" in table)
      return { held: false, reason: `Rows can only be taken away ${table.reason}` };
    if (rows.length === 0) return { held: true, consequences: [] };
    /*
     * A second call on rows already taken puts them back, so the same gesture undoes itself. Cell
     * edits held on a row go with it: there is nothing to update in a row about to be deleted.
     */
    const keys = new Set(rows.map((row) => dataViewRowKey(row)));
    const alreadyGone = rows.every((row) => this.isRemoved(row));
    if (alreadyGone) {
      this.removals = this.removals.filter((row) => !keys.has(dataViewRowKey(row)));
      return { held: true, consequences: [] };
    }
    this.items = this.items.filter((edit) => !keys.has(dataViewRowKey(edit)));
    for (const row of rows) {
      if (!this.isRemoved(row)) this.removals.push(row);
    }
    return { held: true, consequences: describeDeleteConsequences(table) };
  }

  /**
   * Adds an empty row to fill in, or says why it cannot be added. Rows go into one table at a
   * time: there is nowhere to put them without one, and no way to choose between two — the same
   * rule for every surface, worded once.
   */
  addRow(
    editability: DataViewEditability,
    values: Record<string, string | null> = {},
    above = 0,
  ): { held: true } | { held: false; reason: string } {
    const table = dataViewWritableTable(editability);
    if ("reason" in table) return { held: false, reason: `Rows can only be added ${table.reason}` };
    this.added += 1;
    // Held in the order they are shown, so the one just added is the one just under the reader's
    // eye: last among the rows waiting over the same loaded row, and over every row below it.
    const at = this.insertions.findIndex((insertion) => insertion.above > above);
    const row = { tableOid: table.tableOid, localId: `new-${this.added}`, values, above };
    if (at < 0) this.insertions.push(row);
    else this.insertions.splice(at, 0, row);
    return { held: true };
  }

  /** Takes back a row that was added but never written. */
  dropRow(localId: string): void {
    this.insertions = this.insertions.filter((row) => row.localId !== localId);
  }

  /** Fills columns of an added row; clearing one back to nothing leaves it to PostgreSQL. */
  /**
   * A cell of a row being added holds one of three things, and they are not the same row in the
   * database: a value, an explicit NULL, or nothing at all. Only the third is left out of the
   * INSERT, which is what makes the column take the default the table gives it.
   */
  fillRow(
    localId: string,
    values: Record<string, string | null>,
    unset: readonly string[] = [],
  ): void {
    const row = this.insertions.find((candidate) => candidate.localId === localId);
    if (!row) return;
    for (const [column, value] of Object.entries(values)) row.values[column] = value;
    for (const column of unset) delete row.values[column];
  }

  /**
   * Takes one change back out of what is waiting, whichever kind it is. A reader who reads the list
   * before committing to it should be able to change their mind about one line of it without
   * discarding the eight others — and the grid answers straight away, because what it draws is
   * these three lists and nothing else.
   */
  discardChange(change: DataViewChangeHandle): void {
    if (change.of === "insertion") {
      this.insertions = this.insertions.filter((row) => row.localId !== change.localId);
      return;
    }
    const key = dataViewRowKey({ tableOid: change.tableOid, key: change.key });
    if (change.of === "removal") {
      this.removals = this.removals.filter((row) => dataViewRowKey(row) !== key);
      return;
    }
    this.items = this.items.filter(
      (edit) => !(dataViewRowKey(edit) === key && edit.ordinal === change.ordinal),
    );
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
   */
  async applyWith(client: Client, editability: DataViewEditability): Promise<number> {
    /*
     * Rows taken away go first — one of them has no cell left to update — then the cells of the
     * rows that stay, then the rows being added, which nothing else can refer to yet.
     */
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
