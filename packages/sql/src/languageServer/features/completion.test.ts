import { describe, expect, it } from "vitest";
import type { SqlRelationMention } from "../../query/relations.js";
import type { SqlAuthoringSnapshot } from "../../snapshot.js";
import { postgresCompletions } from "./completion.js";

const SNAPSHOT: SqlAuthoringSnapshot = {
  connectionId: "test",
  database: "demo",
  status: "available",
  revision: "1",
  generation: 1,
  foreignKeys: [],
  objects: [
    {
      connectionId: "test",
      database: "demo",
      schema: "shop",
      oid: 1,
      name: "address",
      kind: "table",
      signature: "address",
      parameters: [],
      columns: [
        { name: "id", type: "bigint" },
        { name: "label", type: "text" },
      ],
    },
  ],
};

/** What the syntax tree reports for `FROM shop.address`: columns qualify it by its own name. */
const ADDRESS: SqlRelationMention = {
  schema: "shop",
  name: "address",
  catalogSchema: "shop",
  catalogName: "address",
  reference: "address",
  qualifiedText: "shop.address",
  nameRange: { start: 0, end: 0 },
};

function complete(source: string, caretRole: "relation" | "expression" = "expression") {
  return postgresCompletions(source, source.length, SNAPSHOT, [ADDRESS], caretRole);
}

const labels = (source: string, caretRole?: "relation" | "expression") =>
  complete(source, caretRole).map((item) => String(item.label));

describe("postgresCompletions", () => {
  it("proposes the words a condition is written with", () => {
    const proposed = labels("SELECT id FROM shop.address WHERE an");
    expect(proposed).toContain("AND");
    expect(proposed).toContain("ANY");
    // Written the way they are reached for: one word, not two to be typed in turn.
    expect(labels("SELECT id FROM shop.address WHERE id is n")).toContain("IS NOT NULL");
  });

  it("offers the language after everything the index knows", () => {
    const proposed = labels("SELECT id FROM shop.address WHERE l");
    expect(proposed.indexOf("label")).toBeGreaterThanOrEqual(0);
    expect(proposed.indexOf("LIKE")).toBeGreaterThan(proposed.indexOf("label"));
  });

  it("says what each proposal replaces, so no client has to guess", () => {
    const source = "SELECT id FROM shop.address WHERE lab";
    const [item] = complete(source).filter((candidate) => candidate.label === "label");
    // The fragment the caret sits at the end of, and nothing before it.
    expect(item?.textEdit).toEqual({
      range: {
        start: { line: 0, character: source.length - 3 },
        end: { line: 0, character: source.length },
      },
      // A column of a relation the query names is written through that relation.
      newText: "address.label",
    });
  });

  it("lets a phrase replace every word it continues, not only the last one", () => {
    const source = "SELECT id FROM shop.address WHERE id is n";
    const [item] = complete(source).filter((candidate) => candidate.label === "IS NOT NULL");
    // `is n` goes, not the `n` alone: replacing the word would leave `id is IS NOT NULL`.
    expect(item?.textEdit).toEqual({
      range: {
        start: { line: 0, character: source.length - 4 },
        end: { line: 0, character: source.length },
      },
      newText: "IS NOT NULL",
    });

    const continuing = "SELECT id FROM shop.address WHERE an";
    const [and] = complete(continuing).filter((candidate) => candidate.label === "AND");
    expect(and?.textEdit).toMatchObject({
      range: { start: { character: continuing.length - 2 } },
    });
  });

  it("names a relation where only a relation can go", () => {
    // After FROM the language is not what is missing, and a keyword there composes nothing.
    expect(labels("SELECT * FROM a", "relation")).toEqual(["address"]);
  });
});
