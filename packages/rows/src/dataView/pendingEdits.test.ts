import { describe, expect, it, vi } from "vitest";
import type { DataViewEdit, DataViewEditability } from "./dataView.js";
import { READ_ONLY_REASONS } from "./editability.js";
import { HiddenColumns } from "./hiddenColumns.js";
import {
  type DataViewMove,
  type DataViewMoveHost,
  isDataViewMove,
  PendingEdits,
} from "./pendingEdits.js";

const editability: DataViewEditability = {
  tables: [
    {
      tableOid: 42,
      schema: "shop",
      name: "address",
      keyOrdinals: [0],
      keyColumns: ["id"],
      keyTypes: ["bigint"],
      referencedBy: [{ table: "shop.order", onDelete: "cascade" }],
    },
  ],
  columns: [
    { editable: false, reason: READ_ONLY_REASONS.identity },
    {
      editable: true,
      tableOid: 42,
      column: "city",
      dataType: "text",
      editor: "text",
      hasOwnValue: false,
    },
  ],
  requiredOrdinals: [0],
  technicalOrdinals: [0],
};

const joined: DataViewEditability = {
  ...editability,
  tables: [...editability.tables, { ...editability.tables[0]!, tableOid: 43, name: "order" }],
};

const edit = (over: Partial<DataViewEdit> = {}): DataViewEdit => ({
  tableOid: 42,
  key: ["12"],
  ordinal: 1,
  column: "city",
  original: "Nantes",
  value: "Saint-Nazaire",
  ...over,
});

function surface(hidden = new HiddenColumns()) {
  const said: { message: string; severity: string }[] = [];
  const remembered: { label: string; undo: () => void; redo: () => void }[] = [];
  const changed = vi.fn();
  const host: DataViewMoveHost = {
    notify: (message, severity) => said.push({ message, severity }),
    changed,
    remember: (label, undo, redo) => remembered.push({ label, undo, redo }),
  };
  return { context: { editability, hidden, host }, said, remembered, changed };
}

describe("what a move is", () => {
  it("tells a move from a request that only reads or rewrites", () => {
    expect(isDataViewMove({ type: "data-view/edit", edit: edit() })).toBe(true);
    expect(isDataViewMove({ type: "data-view/remove-rows", rows: [] })).toBe(true);
    expect(isDataViewMove({ type: "data-view/refresh" })).toBe(false);
    expect(isDataViewMove({ type: "data-view/apply" })).toBe(false);
    expect(isDataViewMove({ type: "data-view/discard" })).toBe(false);
  });
});

describe("the one door every move goes through", () => {
  it("holds a cell edit and tells whatever shows the changes", () => {
    const edits = new PendingEdits();
    const { context, changed, said } = surface();
    edits.move({ type: "data-view/edit", edit: edit() }, context);
    expect(edits.list).toEqual([edit()]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(said).toEqual([]);
  });

  it("refuses a column the policy does not let the view change, and says why once", () => {
    const edits = new PendingEdits();
    const { context, changed, said, remembered } = surface();
    edits.move({ type: "data-view/edit", edit: edit({ ordinal: 0, column: "id" }) }, context);
    expect(edits.size).toBe(0);
    expect(said).toEqual([{ message: READ_ONLY_REASONS.identity, severity: "info" }]);
    expect(changed).not.toHaveBeenCalled();
    expect(remembered).toEqual([]);
  });

  it("says what a deletion drags along as the row is taken", () => {
    const edits = new PendingEdits();
    const { context, said } = surface();
    edits.move({ type: "data-view/remove-rows", rows: [{ tableOid: 42, key: ["12"] }] }, context);
    expect(edits.removedRows).toHaveLength(1);
    expect(said).toEqual([
      { message: "Rows of shop.order that point at it are deleted too.", severity: "info" },
    ]);
  });

  it("takes back a row it had taken away, so the same gesture undoes itself", () => {
    const edits = new PendingEdits();
    const { context } = surface();
    const rows = [{ tableOid: 42, key: ["12"] }];
    edits.move({ type: "data-view/remove-rows", rows }, context);
    edits.move({ type: "data-view/remove-rows", rows }, context);
    expect(edits.removedRows).toEqual([]);
  });

  it("refuses whole rows over a join, where no one table owns them", () => {
    const edits = new PendingEdits();
    const { context, said } = surface();
    edits.move({ type: "data-view/add-row" }, { ...context, editability: joined });
    expect(said).toEqual([
      {
        message: "Rows can only be added to one table, and this query joins several.",
        severity: "info",
      },
    ]);
  });

  it("brings back the columns a new row cannot go without", () => {
    const hidden = new HiddenColumns();
    hidden.afterLoad({ technicalKeys: ["42:id"], columnKeys: ["42:id", "42:city"] }, true);
    expect(hidden.list).toEqual(["42:id"]);
    const edits = new PendingEdits();
    edits.move({ type: "data-view/add-row" }, surface(hidden).context);
    expect(hidden.list).toEqual([]);
  });

  it("takes a row back the same way a change of that row is taken back", () => {
    const edits = new PendingEdits();
    const { context } = surface();
    edits.move({ type: "data-view/add-row" }, context);
    const added = edits.addedRows[0];
    expect(added).toBeDefined();
    edits.move({ type: "data-view/drop-row", localId: added?.localId ?? "" }, context);
    expect(edits.addedRows).toEqual([]);
  });

  it("leaves nothing behind when there was nothing to do", () => {
    const edits = new PendingEdits();
    const { context, changed, remembered } = surface();
    edits.move({ type: "data-view/drop-row", localId: "new-404" }, context);
    edits.move({ type: "data-view/remove-rows", rows: [] }, context);
    edits.move(
      { type: "data-view/fill-row", localId: "new-404", values: { city: "Nantes" } },
      context,
    );
    edits.move(
      { type: "data-view/discard-change", change: { kind: "insert", localId: "new-404" } },
      context,
    );
    expect(changed).not.toHaveBeenCalled();
    expect(remembered).toEqual([]);
  });

  it("moves the same for a surface with no undo stack of its own to keep in step", () => {
    const edits = new PendingEdits();
    const said: string[] = [];
    const changed = vi.fn();
    const host: DataViewMoveHost = {
      notify: (message) => said.push(message),
      changed,
    };
    const context = { editability, hidden: new HiddenColumns(), host };
    edits.move({ type: "data-view/edit", edit: edit() }, context);
    edits.move({ type: "data-view/edit", edit: edit({ ordinal: 0, column: "id" }) }, context);
    expect(edits.list).toEqual([edit()]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(said).toEqual([READ_ONLY_REASONS.identity]);
  });

  it("names each move and remembers the way back to what was held before it", () => {
    const edits = new PendingEdits();
    const { context, remembered } = surface();
    edits.move({ type: "data-view/edit", edit: edit() }, context);
    edits.move({ type: "data-view/add-row" }, context);
    expect(remembered.map((entry) => entry.label)).toEqual(["Edit city", "Add row"]);
    remembered[1]?.undo();
    expect(edits.addedRows).toEqual([]);
    expect(edits.list).toEqual([edit()]);
    remembered[0]?.undo();
    expect(edits.list).toEqual([]);
    remembered[0]?.redo();
    expect(edits.list).toEqual([edit()]);
  });
});

describe("a write already under way", () => {
  /** Holds the transaction open so a move can be attempted while the write is in flight. */
  function writing(edits: PendingEdits) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      query: vi.fn(async (text: string) => {
        if (text === "BEGIN") await held;
        return { rowCount: 1, rows: [] };
      }),
      end: vi.fn(async () => {}),
    };
    const applied = edits.apply(
      {
        openClient: async () => client as never,
        notify: () => {},
        changed: () => {},
        reload: async () => {},
        connectionName: () => "demo",
      },
      editability,
    );
    return { applied, release };
  }

  it("refuses every move, not only the cell edits, and says the same sentence to each", async () => {
    const edits = new PendingEdits();
    const start = surface();
    edits.move({ type: "data-view/edit", edit: edit() }, start.context);
    const { applied, release } = writing(edits);
    await Promise.resolve();
    expect(edits.applying).toBe(true);

    const { context, said, changed } = surface();
    const moves: DataViewMove[] = [
      { type: "data-view/edit", edit: edit({ value: "Rezé" }) },
      { type: "data-view/add-row" },
      { type: "data-view/remove-rows", rows: [{ tableOid: 42, key: ["12"] }] },
      { type: "data-view/drop-row", localId: "new-1" },
      { type: "data-view/fill-row", localId: "new-1", values: {} },
      { type: "data-view/discard-change", change: { kind: "insert", localId: "new-1" } },
    ];
    for (const move of moves) edits.move(move, context);
    expect(said).toEqual(
      moves.map(() => ({ message: READ_ONLY_REASONS.applying, severity: "info" })),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(edits.addedRows).toEqual([]);
    expect(edits.removedRows).toEqual([]);

    release();
    await applied;
    expect(edits.size).toBe(0);
  });
});
