import type { Client } from "pg";
import { countLabel } from "./countLabel.js";
import {
  type DataViewEdit,
  type DataViewEditability,
  type DataViewRowInsertion,
  type DataViewRowRemoval,
  dataViewRowKey,
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
  /** How the server is named to a reader. */
  serverName(): string;
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
      host.notify(`${countLabel(applied, "change")} applied to ${host.serverName()}.`, "info");
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
    const restoresOriginal = edit.value === edit.original;
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
   * go with it: there is nothing to update in a row that is about to be deleted.
   */
  toggleRemoval(row: DataViewRowRemoval): void {
    const key = dataViewRowKey(row);
    if (this.isRemoved(row)) {
      this.removals = this.removals.filter((candidate) => dataViewRowKey(candidate) !== key);
      return;
    }
    this.items = this.items.filter((candidate) => dataViewRowKey(candidate) !== key);
    this.removals.push(row);
  }

  /** Adds an empty row to fill in, and answers with the identity the grid will call it by. */
  addRow(tableOid: number): string {
    this.added += 1;
    const localId = `new-${this.added}`;
    this.insertions.push({ tableOid, localId, values: {} });
    return localId;
  }

  /** Takes back a row that was added but never written. */
  dropRow(localId: string): void {
    this.insertions = this.insertions.filter((row) => row.localId !== localId);
  }

  /** Fills one column of an added row; clearing it back to nothing leaves it to PostgreSQL. */
  fillRow(localId: string, column: string, value: string | null): void {
    const row = this.insertions.find((candidate) => candidate.localId === localId);
    if (!row) return;
    if (value === null) delete row.values[column];
    else row.values[column] = value;
  }

  clear(): void {
    this.items = [];
    this.removals = [];
    this.insertions = [];
  }

  /**
   * Lets go of every change whose table the query no longer writes to, and says how many were
   * let go. A change is held against a table; once the reader has composed that table away there
   * is nowhere to write it, and keeping it only fails later with a puzzling message.
   */
  forget(editability: DataViewEditability): number {
    const writable = new Set(editability.tables.map((table) => table.tableOid));
    const before = this.size;
    this.items = this.items.filter((edit) => writable.has(edit.tableOid));
    this.removals = this.removals.filter((removal) => writable.has(removal.tableOid));
    this.insertions = this.insertions.filter((row) => writable.has(row.tableOid));
    return before - this.size;
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
    this.items = [];
    this.removals = [];
    this.insertions = [];
    return applied;
  }
}
