import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";
import {
  analyzeSqlQuery,
  formatSqlQuery,
  relationReference,
  removeRelation,
  type SqlQueryAnalysis,
  type SqlQueryRelation,
} from "../packages/sql/src/query/analysis.js";
import { composePostgresSql } from "../packages/sql/src/query/composition.js";
import type { SqlAuthoringForeignKey, SqlAuthoringSnapshot } from "../packages/sql/src/snapshot.js";

/**
 * The composition engine is driven by pointing and clicking, so a reader reaches shapes no
 * hand-written scenario enumerates: a mapping table pulled in behind their back, two paths to the
 * same relation, a self-reference. This campaign composes at random and then takes the query apart
 * in a random order, and holds every intermediate query to the invariants below. Two or three
 * scenarios cannot cover that space; a seeded campaign can, and it names the seed when it fails.
 */

const foreignKey = (
  sourceTableOid: number,
  sourceColumns: string[],
  targetTableOid: number,
  targetColumns: string[],
  nullable = false,
): SqlAuthoringForeignKey => ({
  sourceTableOid,
  targetTableOid,
  sourceColumns,
  sourceColumnsNullable: sourceColumns.map(() => nullable),
  targetColumns,
  validated: true,
});

const table = (oid: number, name: string, columns: string[]) => ({
  connectionId: "demo-connection",
  database: "demo",
  schema: "shop",
  oid,
  name,
  kind: "table" as const,
  signature: "",
  parameters: [],
  columns: columns.map((column) => ({ name: column, type: "text" })),
});

/**
 * The shapes that break naive removal, in one graph: a chain (order → line → product → brand), a
 * mapping table nobody asked for (product_category), two foreign keys to the same relation
 * (sales_order billing and shipping), a self-reference (category.parent_id), a diamond
 * (warehouse and app_user both reach organization) and a relation nothing links to (orphan).
 */
const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  connectionId: "demo-connection",
  database: "demo",
  revision: "r1",
  generation: 1,
  objects: [
    table(1, "product", ["id", "name", "brand_id"]),
    table(2, "brand", ["id", "label"]),
    table(3, "product_category", ["product_id", "category_id"]),
    table(4, "category", ["id", "title", "parent_id"]),
    table(5, "address", ["id", "city"]),
    table(6, "sales_order", ["id", "billing_address_id", "shipping_address_id"]),
    table(7, "orphan", ["id"]),
    table(8, "organization", ["id", "label"]),
    table(9, "warehouse", ["id", "organization_id", "address_id"]),
    table(10, "inventory", ["id", "product_id", "warehouse_id", "quantity"]),
    table(11, "app_user", ["id", "organization_id", "email"]),
    table(12, "order_line", ["id", "sales_order_id", "product_id"]),
  ],
  foreignKeys: [
    foreignKey(1, ["brand_id"], 2, ["id"]),
    foreignKey(3, ["product_id"], 1, ["id"]),
    foreignKey(3, ["category_id"], 4, ["id"]),
    foreignKey(4, ["parent_id"], 4, ["id"], true),
    foreignKey(6, ["billing_address_id"], 5, ["id"]),
    foreignKey(6, ["shipping_address_id"], 5, ["id"], true),
    foreignKey(9, ["organization_id"], 8, ["id"]),
    foreignKey(9, ["address_id"], 5, ["id"], true),
    foreignKey(10, ["product_id"], 1, ["id"]),
    foreignKey(10, ["warehouse_id"], 9, ["id"]),
    foreignKey(11, ["organization_id"], 8, ["id"], true),
    foreignKey(12, ["sales_order_id"], 6, ["id"]),
    foreignKey(12, ["product_id"], 1, ["id"]),
  ],
};

const RELATIONS = snapshot.objects.map((object) => ({ oid: object.oid, name: object.name }));

/** A seeded generator, so a failing campaign is replayed by naming its seed and nothing else. */
function randomSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SQL composition invariants", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "composition-invariants-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-composition-invariants",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
    dispose = async () => {
      await session.dispose();
      await rm(workspace, { force: true, recursive: true });
    };
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  const analyze = async (sql: string): Promise<SqlQueryAnalysis> => {
    const result = await analyzeSqlQuery(sql, parser);
    if (result.status !== "ok") throw new Error(`not analyzable: ${result.message}\n${sql}`);
    return result.analysis;
  };

  /** Composes one relation into the query the way the SQL authoring server does. */
  async function add(
    text: string,
    relation: { oid: number; name: string },
    relationChoice?: number,
  ) {
    const analyzed = text === "" ? undefined : await analyzeSqlQuery(text, parser);
    return composePostgresSql(
      {
        text,
        offset: text.length,
        payload: {
          kind: "table" as const,
          connectionId: "demo-connection",
          database: "demo",
          oid: relation.oid,
          schema: "shop",
          name: relation.name,
        },
        ...(relationChoice === undefined ? {} : { relationChoice }),
      },
      snapshot,
      undefined,
      analyzed?.status === "ok" ? analyzed.analysis : undefined,
      analyzed?.shape,
    );
  }

  /** The projected columns that belong to one relation, as the Data View reports them. */
  const ownedOrdinals = (analysis: SqlQueryAnalysis, relation: SqlQueryRelation): number[] => {
    const owner = relationReference(relation);
    return analysis.targets.flatMap((target, ordinal) =>
      target.qualifiers.length > 0 && target.qualifiers.every((qualifier) => qualifier === owner)
        ? [ordinal]
        : [],
    );
  };

  /**
   * Every property a composed query must hold, whatever the road that produced it. A violation is
   * reported with the query itself, because the shape is what a reader needs to see, not an index.
   */
  function expectWellFormed(sql: string, analysis: SqlQueryAnalysis, trail: string) {
    const where = (claim: string) => `${claim}\n--- seed trail: ${trail}\n${sql}`;
    const live = new Set(analysis.relations.map(relationReference));

    // One base relation, and it is the one the FROM starts with.
    const bases = analysis.relations.filter((relation) => !relation.join);
    expect(bases.length, where("a query must have exactly one base relation")).toBe(1);
    expect(analysis.relations[0]?.join, where("the base relation must open the FROM clause")).toBe(
      undefined,
    );

    // No relation may appear twice: two aliases that collide make every qualifier ambiguous.
    expect(live.size, where("every relation must be reachable by a distinct qualifier")).toBe(
      analysis.relations.length,
    );

    /**
     * Every joined relation carries an ON condition that names itself and something declared
     * before it. That is what forbids both a cartesian product — a JOIN with no cardinality — and
     * a cycle: a relation can only attach to the part of the FROM that is already built.
     */
    const first = analysis.relations[0];
    const declared = new Set<string>(first ? [relationReference(first)] : []);
    for (const relation of analysis.relations.slice(1)) {
      const reference = relationReference(relation);
      const qualifiers = relation.join?.qualifiers ?? [];
      expect(
        qualifiers.length,
        where(`${reference} is joined without a condition`),
      ).toBeGreaterThan(0);
      expect(
        qualifiers.some((qualifier) => declared.has(qualifier)),
        where(`${reference} joins nothing that precedes it`),
      ).toBe(true);
      for (const qualifier of qualifiers) {
        expect(
          declared.has(qualifier) || qualifier === reference,
          where(`${reference} joins ${qualifier}, which the FROM clause declares later`),
        ).toBe(true);
      }
      declared.add(reference);
    }

    // Nothing may name a relation the FROM clause no longer holds.
    const orphans = (qualifiers: readonly string[]) =>
      qualifiers.filter((qualifier) => !live.has(qualifier));
    for (const target of analysis.targets) {
      expect(orphans(target.qualifiers), where(`projected ${target.text} is orphaned`)).toEqual([]);
    }
    for (const item of analysis.sortItems) {
      expect(orphans(item.qualifiers), where(`ORDER BY ${item.text} is orphaned`)).toEqual([]);
    }
    expect(
      orphans(analysis.where?.qualifiers ?? []),
      where("the WHERE clause is orphaned"),
    ).toEqual([]);

    /**
     * Every relation earns its place: it shows a column, filters, sorts, or lies on the join path
     * of one that does. A relation that carries nothing has no badge either — the reader would see
     * a table they never asked for and have no way to take it away.
     */
    if (!analysis.hasStar) {
      const carried = new Set<string>();
      for (const qualifiers of [
        ...analysis.targets.map((target) => target.qualifiers),
        ...analysis.sortItems.map((item) => item.qualifiers),
        analysis.where?.qualifiers ?? [],
      ]) {
        for (const qualifier of qualifiers) carried.add(qualifier);
      }
      const load = new Set(
        analysis.relations.filter((relation) => carried.has(relationReference(relation))),
      );
      let grew = true;
      while (grew) {
        grew = false;
        for (const relation of load) {
          for (const qualifier of relation.join?.qualifiers ?? []) {
            const carrier = analysis.relations.find(
              (other) => relationReference(other) === qualifier,
            );
            if (carrier && !load.has(carrier)) {
              load.add(carrier);
              grew = true;
            }
          }
        }
      }
      const idle = analysis.relations
        .filter((relation) => !load.has(relation))
        .map((relation) => relation.reference);
      expect(idle, where("these relations carry nothing and cannot be removed")).toEqual([]);
    }
  }

  /**
   * One campaign: compose relations at random, then take them away in a random order. Every
   * intermediate query is analyzed and held to the invariants, and the run only ends on the empty
   * query — a relation a reader can add is a relation they must be able to remove.
   */
  /** What the campaign actually exercised, so a run that quietly stops composing is caught. */
  const reached = { widest: 0, removals: 0, promotions: 0, cascades: 0 };

  async function runCampaign(seed: number) {
    const next = randomSequence(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const steps: string[] = [];
    let text = "";

    for (let round = 0; round < 7; round += 1) {
      const relation = pick(RELATIONS);
      let composed = await add(text, relation);
      if (composed.status === "ambiguous") {
        const choice = pick(composed.choices).index;
        steps.push(`add ${relation.name} (choice ${choice})`);
        composed = await add(text, relation, choice);
      } else {
        steps.push(`add ${relation.name}`);
      }
      // A relation no path reaches is refused, and refusing it is the right answer.
      if (composed.status !== "edit") {
        steps.push(`  refused: ${composed.status === "rejected" ? composed.message : "ambiguous"}`);
        continue;
      }
      /**
       * The query a Data View holds is formatted and carries no terminator, and that is what the
       * next composition is offered: with a `;` in the way the cursor sits past the statement and
       * the engine has no query to join to.
       */
      composed = { ...composed, text: formatSqlQuery(composed.text) };
      /**
       * No join reaches the relation, so the engine opened a second statement beside the first.
       * A Data View holds one query, so that composition is not one it can accept: the relation
       * stays out and the query is left as it was.
       */
      const analyzed = await analyzeSqlQuery(composed.text, parser);
      if (analyzed.status !== "ok") {
        steps.push(`  unreachable from the query: ${analyzed.message}`);
        continue;
      }
      text = composed.text;
      reached.widest = Math.max(reached.widest, analyzed.analysis.relations.length);
      expectWellFormed(text, analyzed.analysis, steps.join("\n"));
    }

    if (text === "") return;

    for (let guard = 0; guard < 40 && text !== ""; guard += 1) {
      const analysis = await analyze(text);
      const relation = pick(analysis.relations);
      steps.push(`remove ${relation.reference}`);
      reached.removals += 1;
      if (!relation.join && analysis.relations.length > 1) reached.promotions += 1;
      const removal = removeRelation(text, analysis, relation, ownedOrdinals(analysis, relation));
      expect(
        removal.status,
        `removing ${relation.reference} was refused: ${
          removal.status === "rejected" ? removal.message : ""
        }\n--- seed trail: ${steps.join("\n")}\n${text}`,
      ).not.toBe("rejected");
      if (removal.status === "empty") {
        text = "";
        break;
      }
      if (removal.status !== "removed") break;
      if (removal.alsoRemoved.length > 0) reached.cascades += 1;
      text = removal.text;
      expectWellFormed(text, await analyze(text), steps.join("\n"));
    }

    expect(text, `the query never emptied\n--- seed trail: ${steps.join("\n")}`).toBe("");
  }

  const seeds = Array.from({ length: 60 }, (_unused, index) => 1000 + index * 7);
  it.each(seeds)(
    "composes and takes apart the query again (seed %i)",
    async (seed) => {
      await runCampaign(seed);
    },
    60_000,
  );

  it("exercised the shapes the campaign is there to reach", () => {
    // A campaign that composes nothing would pass every invariant without proving anything.
    expect(
      reached.widest,
      `widest query reached: ${JSON.stringify(reached)}`,
    ).toBeGreaterThanOrEqual(4);
    expect(
      reached.removals,
      `removals performed: ${JSON.stringify(reached)}`,
    ).toBeGreaterThanOrEqual(150);
    expect(reached.promotions, `base removals: ${JSON.stringify(reached)}`).toBeGreaterThanOrEqual(
      30,
    );
    expect(
      reached.cascades,
      `cascading removals: ${JSON.stringify(reached)}`,
    ).toBeGreaterThanOrEqual(5);
    expect(reached.widest, `widest query reached: ${JSON.stringify(reached)}`).toBeLessThanOrEqual(
      12,
    );
  });

  it("takes the mapping table away with the last relation it was bridging", async () => {
    // Reached by adding app_user, then inventory: the engine crossed inventory_movement to get
    // there. Nothing projects the mapping table, so it has no badge — and once both ends are gone
    // it must go too, instead of leaving a `SELECT *` over a table nobody asked for.
    const sql = [
      "SELECT app_user.email, inventory.quantity",
      "FROM shop.app_user AS app_user",
      "  LEFT JOIN shop.inventory_movement AS inventory_movement" +
        " ON app_user.id = inventory_movement.performed_by",
      "  LEFT JOIN shop.inventory AS inventory ON inventory_movement.inventory_id = inventory.id",
    ].join("\n");

    const first = await analyze(sql);
    const appUser = first.relations.find((relation) => relation.name === "app_user");
    if (!appUser) throw new Error("no app_user relation");
    const withoutUser = removeRelation(sql, first, appUser, [0]);
    expect(withoutUser.status).toBe("removed");
    if (withoutUser.status !== "removed") return;
    // The mapping table still carries the join that reaches what is left, so it stays.
    expect(withoutUser.text).toContain("FROM shop.inventory_movement AS inventory_movement");
    expectWellFormed(withoutUser.text, await analyze(withoutUser.text), "bridge still carrying");

    const second = await analyze(withoutUser.text);
    const inventory = second.relations.find((relation) => relation.name === "inventory");
    if (!inventory) throw new Error("no inventory relation");
    const removal = removeRelation(
      withoutUser.text,
      second,
      inventory,
      ownedOrdinals(second, inventory),
    );

    expect(removal.status, "the mapping table outlived both relations it bridged").toBe("empty");
  });

  it("removes the base relation of a chain that reaches it through a mapping table", async () => {
    // The shape the Data View reaches by adding a warehouse address, then a user of the same
    // organization: `inventory` opens the FROM and nothing else references it.
    const sql = [
      "SELECT inventory.id, inventory.quantity, app_user.email",
      "FROM shop.inventory AS inventory",
      "  JOIN shop.warehouse AS warehouse ON inventory.warehouse_id = warehouse.id",
      "  JOIN shop.organization AS organization ON warehouse.organization_id = organization.id",
      "  LEFT JOIN shop.app_user AS app_user ON organization.id = app_user.organization_id",
    ].join("\n");
    const analysis = await analyze(sql);
    const inventory = analysis.relations.find((relation) => relation.name === "inventory");
    if (!inventory) throw new Error("no inventory relation");

    const removal = removeRelation(sql, analysis, inventory, [0, 1]);

    expect(removal.status).toBe("removed");
    if (removal.status !== "removed") return;
    expect(removal.alsoRemoved).toEqual([]);
    expect(removal.text).toContain("FROM shop.warehouse AS warehouse");
    expect(removal.text).not.toContain("inventory");
    expectWellFormed(removal.text, await analyze(removal.text), "base of a mapped chain");
  });
});
