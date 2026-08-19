import type { Client } from "pg";
import {
  type DataViewEdit,
  type DataViewEditability,
  sameDataViewRow,
} from "../../views/src/dataView/protocol.js";
import { buildRowUpdates } from "./updates.js";

/** Local, unapplied cell edits of a Data View, and their atomic application. */
export class PendingEdits {
  private items: DataViewEdit[] = [];

  get list(): readonly DataViewEdit[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
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
