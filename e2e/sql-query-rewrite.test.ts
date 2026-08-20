import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeSqlQuery,
  removeRelation,
  type SqlQueryAnalysis,
} from "../packages/sql/src/query/analysis.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

/**
 * Relation removal decides what depends on a relation from the column references of the syntax
 * tree. These cases are the ones text matching gets wrong: a qualifier that does not follow a
 * space, and a relation name that only occurs inside a string literal or a comment.
 */
describe("SQL query relation removal", () => {
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
  }, 30_000);

  afterAll(async () => {
    await codeMoniker?.dispose();
  });

  const analyze = async (sql: string): Promise<SqlQueryAnalysis> => {
    const result = await analyzeSqlQuery(sql, codeMoniker.parser);
    if (result.status !== "ok") throw new Error(`not analyzable: ${result.message}`);
    return result.analysis;
  };

  const removeJoined = async (sql: string, name: string, ownedOrdinals: number[] = []) => {
    const analysis = await analyze(sql);
    const relation = analysis.relations.find((candidate) => candidate.name === name);
    if (!relation) throw new Error(`no relation named ${name}`);
    return removeRelation(sql, analysis, relation, ownedOrdinals);
  };

  it("resolves qualifiers that no separator precedes", async () => {
    const removal = await removeJoined(
      "SELECT a.x,b.k FROM s.first AS a JOIN s.second AS b ON a.id=b.first_id " +
        "JOIN s.third AS c ON c.second_id=b.id",
      "second",
      [1],
    );

    // `b` is named after `=` and after a comma: both the ORDER-free target and the JOIN of `c`
    // depend on it, and a text scan for " b." finds neither.
    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.alsoRemoved).toEqual(["third"]);
    expect(removal.text).not.toContain("b.k");
    expect(removal.text).not.toContain("s.third");
  });

  it("keeps a WHERE whose only mention of the relation is inside a literal", async () => {
    const removal = await removeJoined(
      "SELECT a.x, b.k FROM s.first AS a JOIN s.second AS b ON a.id = b.first_id " +
        "WHERE a.city = 'near b.town'",
      "second",
      [1],
    );

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).toContain("'near b.town'");
    expect(removal.text).toContain("a.city");
  });

  it("drops a WHERE that really references the removed relation", async () => {
    const removal = await removeJoined(
      "SELECT a.x, b.k FROM s.first AS a JOIN s.second AS b ON a.id = b.first_id WHERE b.k > 1",
      "second",
      [1],
    );

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).not.toContain("WHERE");
  });

  it("resolves quoted aliases and unaliased relation names", async () => {
    const analysis = await analyze(
      'SELECT a.x, "Odd Alias".k, s.second.j FROM s.first AS a ' +
        'JOIN s.second AS "Odd Alias" ON a.id = "Odd Alias".first_id JOIN s.second ON true',
    );

    expect(analysis.targets.map((target) => target.qualifiers)).toEqual([
      ["a"],
      ["Odd Alias"],
      ["s", "second"],
    ]);
  });

  it("keeps ranges aligned when the text is not ASCII", async () => {
    // Node ranges arrive in bytes: an accent (2 bytes) or an emoji (4 bytes, 2 UTF-16 units)
    // shifts every following character offset.
    const sql =
      "SELECT a.\"région\" FROM s.first AS a WHERE a.city = 'Genève 🌍' ORDER BY a.id DESC";
    const analysis = await analyze(sql);

    if (!analysis.where) throw new Error("no WHERE clause");
    expect(sql.slice(analysis.where.expressionStart, analysis.where.end)).toBe(
      "a.city = 'Genève 🌍'",
    );
    expect(analysis.targets[0]?.text).toBe('a."région"');
    expect(analysis.sortItems[0]?.text).toBe("a.id DESC");
  });

  it("reports no qualifier for an unqualified column", async () => {
    const analysis = await analyze("SELECT x, count(*) AS total FROM s.first GROUP BY x");

    expect(analysis.targets.map((target) => target.qualifiers)).toEqual([[], []]);
  });

  it("promotes a joined relation when the base is removed", async () => {
    const removal = await removeJoined(
      "SELECT a.x, b.k FROM s.first AS a JOIN s.second AS b ON a.id = b.first_id",
      "first",
      [0],
    );

    // Which relation the FROM starts with is the order they were composed, not a choice: the
    // first joined one takes its place and loses the condition that joined it to what is gone.
    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).toMatch(/FROM\s+s\.second AS b/u);
    expect(removal.text).not.toContain("s.first");
    expect(removal.text).not.toContain("a.id");
    expect(removal.alsoRemoved).toEqual([]);
  });

  it("keeps what joined to the promoted relation, and drops what joined to the removed one", async () => {
    const removal = await removeJoined(
      "SELECT a.x, b.k, c.j FROM s.first AS a " +
        "JOIN s.second AS b ON a.id = b.first_id " +
        "JOIN s.third AS c ON c.second_id = b.id",
      "first",
      [0],
    );

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).toMatch(/FROM\s+s\.second AS b/u);
    expect(removal.text).toContain("s.third");
    expect(removal.text).toContain("c.second_id = b.id");
    expect(removal.alsoRemoved).toEqual([]);
  });

  it("drops a relation that only reached the query through the removed base", async () => {
    const removal = await removeJoined(
      "SELECT a.x, b.k, c.j FROM s.first AS a " +
        "JOIN s.second AS b ON a.id = b.first_id " +
        "JOIN s.third AS c ON c.first_id = a.id",
      "first",
      [0],
    );

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).toMatch(/FROM\s+s\.second AS b/u);
    expect(removal.alsoRemoved).toEqual(["third"]);
  });

  it("empties the query when the only relation is removed", async () => {
    const analysis = await analyze("SELECT a.x FROM s.first AS a");
    const relation = analysis.relations[0];
    if (!relation) throw new Error("no relation");

    expect(removeRelation("SELECT a.x FROM s.first AS a", analysis, relation, [0]).status).toBe(
      "empty",
    );
  });

  it("removes a joined relation from the FROM clause, not only from the projection", async () => {
    // The shape a Data View composes: every column of both relations, joined on the foreign key.
    const text =
      "SELECT inventory.id, inventory.product_id, inventory.quantity, " +
      "product.id, product.name, product.price " +
      "FROM s.inventory AS inventory JOIN s.product AS product ON inventory.product_id = product.id";
    const analysis = await analyze(text);
    const product = analysis.relations.find((candidate) => candidate.name === "product");
    if (!product) throw new Error("no product relation");

    const removal = removeRelation(text, analysis, product, [3, 4, 5]);

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.text).not.toContain("JOIN");
    expect(removal.text).not.toContain("s.product");
    expect(removal.text).not.toContain("product.name");
    expect(removal.text).toMatch(/FROM\s+s\.inventory AS inventory/u);
  });
});
