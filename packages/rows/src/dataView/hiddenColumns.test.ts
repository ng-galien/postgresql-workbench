import { describe, expect, it } from "vitest";
import type { DataViewProjection } from "./dataView.js";
import { HiddenColumns } from "./hiddenColumns.js";

/** Two tables of one join, both with a column called `name`. */
const JOINED: DataViewProjection = {
  tables: [
    { tableOid: 11, schema: "shop", name: "product", accent: 0 },
    { tableOid: 22, schema: "shop", name: "brand", accent: 1 },
  ],
  columnTable: [0, 0, 1],
};
const NAMES = ["id", "name", "name"];
/** What the projection above makes of those columns: the table, then the label. */
const KEYS = ["11:id", "11:name", "22:name"];

describe("which columns a Data View is not showing", () => {
  it("hides and shows one column, and shows every one of them again", () => {
    const hidden = new HiddenColumns();

    hidden.hide(KEYS[1] as string);
    expect(hidden.list).toEqual(["11:name"]);
    hidden.hide(KEYS[2] as string);
    hidden.unhide(KEYS[1] as string);
    expect(hidden.list).toEqual(["22:name"]);
    hidden.unhide();
    expect(hidden.list).toEqual([]);
  });

  it("tells two columns of the same name apart by the table they come from", () => {
    const hidden = new HiddenColumns();

    hidden.hide("11:name");

    // Hiding `product.name` leaves `brand.name` on screen, and out of nothing else.
    expect(hidden.shownOrdinals(JOINED, NAMES)).toEqual([0, 2]);
  });

  it("leaves a hidden column out of what a surface takes", () => {
    const hidden = new HiddenColumns();
    expect(hidden.shownOrdinals(JOINED, NAMES)).toEqual([0, 1, 2]);

    hidden.hide("11:id");

    /*
     * The ordinals, not the labels: a column is named by its key, and asking for the labels here
     * is what once wrote hidden columns into an exported file while the preview beside it left
     * them out — the two answered the question in two different places.
     */
    expect(hidden.shownOrdinals(JOINED, NAMES)).toEqual([1, 2]);
  });

  it("starts a technical column hidden the first time it appears", () => {
    const hidden = new HiddenColumns();

    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: KEYS }, true);

    expect(hidden.list).toEqual(["11:id"]);
  });

  it("keeps what the reader chose for a column it has already shown", () => {
    const hidden = new HiddenColumns();
    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: ["11:id", "11:name"] }, true);
    hidden.unhide("11:id");

    // A second load of the same columns must not hide it again behind their back.
    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: ["11:id", "11:name"] }, true);
    expect(hidden.list).toEqual([]);

    // A JOIN brings one in that has never been shown: that one does start hidden.
    hidden.afterLoad({ technicalKeys: ["11:id", "22:brand_id"], columnKeys: KEYS }, true);
    expect(hidden.list).toEqual(["22:brand_id"]);
  });

  it("hides nothing when the reader asked for nothing to be hidden, but remembers what it saw", () => {
    const hidden = new HiddenColumns();

    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: KEYS }, false);
    expect(hidden.list).toEqual([]);

    /*
     * Turning the setting on later must not then hide a column they have been reading all along:
     * having seen it is what decides, and that is remembered either way.
     */
    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: KEYS }, true);
    expect(hidden.list).toEqual([]);
  });

  it("hides and shows the technical columns together, because the reader asked about the group", () => {
    const hidden = new HiddenColumns();
    hidden.afterLoad({ technicalKeys: ["11:id", "22:name"], columnKeys: KEYS }, false);
    hidden.hide("11:name");

    hidden.hideTechnical(true);
    expect([...hidden.list].sort()).toEqual(["11:id", "11:name", "22:name"]);

    // Showing them again leaves the one the reader hid by hand where they put it.
    hidden.hideTechnical(false);
    expect(hidden.list).toEqual(["11:name"]);
  });

  it("forgets everything, including what it had seen", () => {
    const hidden = new HiddenColumns();
    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: KEYS }, true);

    hidden.clear();
    expect(hidden.list).toEqual([]);

    // Having forgotten it, the same technical column starts hidden again.
    hidden.afterLoad({ technicalKeys: ["11:id"], columnKeys: KEYS }, true);
    expect(hidden.list).toEqual(["11:id"]);
  });
});
