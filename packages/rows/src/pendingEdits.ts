import type { Client } from "pg";
import { countLabel } from "./countLabel.js";
import { type DataViewEdit, type DataViewEditability, sameDataViewRow } from "./dataView.js";
import { READ_ONLY_REASONS } from "./editability.js";
import { buildRowUpdates } from "./updates.js";

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
  private writing = false;

  get list(): readonly DataViewEdit[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
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
    if (this.items.length === 0 || this.writing) return;
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

  clear(): void {
    this.items = [];
  }

  /**
   * Applies every edit in one transaction on the given client and clears them; throws with the
   * database unchanged (ROLLBACK) when a row is stale, gone, or ambiguous.
   */
  async applyWith(client: Client, editability: DataViewEditability): Promise<number> {
    const updates = buildRowUpdates(this.items, editability);
    await client.query("BEGIN");
    try {
      for (const update of updates) {
        const result = await client.query(update.text, update.values);
        if (result.rowCount !== 1) {
          throw new Error(
            result.rowCount === 0
              ? `${update.target} changed or disappeared since it was loaded. Nothing was applied; refresh and edit again.`
              : `${update.target} matched ${result.rowCount} rows. Nothing was applied.`,
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    const applied = this.items.length;
    this.items = [];
    return applied;
  }
}
