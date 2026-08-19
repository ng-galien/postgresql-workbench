import { describe, expect, it } from "vitest";
import { planJoinPaths, reachableJoinTargets, shortestJoinPlans } from "./joinPlanner.js";
import type { SqlAuthoringForeignKey, SqlAuthoringSnapshot } from "./snapshot.js";

// product(1) —brand_id→ brand(2); product_category(3) —product_id→ product, —category_id→ category(4);
// category —parent_id→ category; address(5) ←billing/shipping— sales_order(6); orphan(7).
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
  serverId: "demo-server",
  database: "demo",
  schema: "shop",
  oid,
  name,
  kind: "table" as const,
  signature: "",
  parameters: [],
  columns: columns.map((column) => ({ name: column, type: "text" })),
});

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  serverId: "demo-server",
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
  ],
  foreignKeys: [
    foreignKey(1, ["brand_id"], 2, ["id"]),
    foreignKey(3, ["product_id"], 1, ["id"]),
    foreignKey(3, ["category_id"], 4, ["id"]),
    foreignKey(4, ["parent_id"], 4, ["id"], true),
    foreignKey(6, ["billing_address_id"], 5, ["id"]),
    foreignKey(6, ["shipping_address_id"], 5, ["id"], true),
  ],
};

describe("join planner", () => {
  it("finds a direct key, and a path through a mapping table when there is no direct key", () => {
    expect(planJoinPaths(snapshot, [1], 2).map((plan) => plan.hops.length)).toEqual([1]);
    const viaMapping = planJoinPaths(snapshot, [1], 4);
    expect(viaMapping).toHaveLength(1);
    expect(viaMapping[0]?.viaOids).toEqual([3]);
    expect(viaMapping[0]?.hops.map((hop) => [hop.fromOid, hop.toOid])).toEqual([
      [1, 3],
      [3, 4],
    ]);
  });

  it("returns every shortest alternative in declaration order and nothing for unreachable tables", () => {
    const plans = planJoinPaths(snapshot, [6], 5);
    expect(plans.map((plan) => plan.hops[0]?.foreignKey.sourceColumns[0])).toEqual([
      "billing_address_id",
      "shipping_address_id",
    ]);
    expect(shortestJoinPlans(plans)).toHaveLength(2);
    expect(planJoinPaths(snapshot, [1], 7)).toEqual([]);
    expect(planJoinPaths(snapshot, [1], 1)).toEqual([]);
  });

  it("never routes through another relation of the query, and lists reachable targets", () => {
    // category is reachable from product only through product_category; once product_category is
    // in the query, the plan starts there.
    const plans = planJoinPaths(snapshot, [1, 3], 4);
    expect(plans.map((plan) => [plan.startIndex, plan.startOid, plan.hops.length])).toEqual([
      [1, 3, 1],
    ]);
    const reachable = reachableJoinTargets(snapshot, [1], [2, 3, 4, 5, 7], { maxHops: 2 });
    expect([...reachable.keys()]).toEqual([2, 3, 4]);
    expect(reachable.get(4)?.[0]?.viaOids).toEqual([3]);
  });
});
