import { describe, expect, it } from "vitest";
import type { SqlAuthoringForeignKey, SqlAuthoringObject } from "../snapshot.js";
import { joinPlanDescription } from "./composition.js";
import type { JoinPlan } from "./joinPlanner.js";
import type { TableReference } from "./relations.js";

function relation(oid: number, name: string): SqlAuthoringObject {
  return {
    serverId: "test",
    database: "demo",
    schema: "shop",
    oid,
    name,
    kind: "table",
    signature: name,
    parameters: [],
    columns: [],
  };
}

const ADDRESS = relation(1, "address");
const SALES_ORDER = relation(2, "sales_order");
const APP_USER = relation(3, "app_user");

function foreignKey(
  sourceTableOid: number,
  sourceColumns: string[],
  targetTableOid: number,
): SqlAuthoringForeignKey {
  return {
    sourceTableOid,
    targetTableOid,
    sourceColumns,
    sourceColumnsNullable: sourceColumns.map(() => true),
    targetColumns: ["id"],
    validated: true,
  };
}

const START: TableReference = {
  correlationName: "address",
  nullExtended: false,
  object: ADDRESS,
  reference: "address",
};

/** address ← sales_order.<addressColumn>, then sales_order.created_by → app_user. */
function planThroughSalesOrder(addressColumn: string): JoinPlan {
  return {
    startIndex: 0,
    startOid: ADDRESS.oid,
    targetOid: APP_USER.oid,
    viaOids: [SALES_ORDER.oid],
    hops: [
      {
        foreignKey: foreignKey(SALES_ORDER.oid, [addressColumn], ADDRESS.oid),
        fromOid: ADDRESS.oid,
        toOid: SALES_ORDER.oid,
      },
      {
        foreignKey: foreignKey(SALES_ORDER.oid, ["created_by"], APP_USER.oid),
        fromOid: SALES_ORDER.oid,
        toOid: APP_USER.oid,
      },
    ],
  };
}

const OBJECTS = [ADDRESS, SALES_ORDER, APP_USER];

describe("joinPlanDescription", () => {
  it("tells apart two paths that traverse the same relations", () => {
    const billing = joinPlanDescription(
      planThroughSalesOrder("billing_address_id"),
      [START],
      OBJECTS,
    );
    const shipping = joinPlanDescription(
      planThroughSalesOrder("shipping_address_id"),
      [START],
      OBJECTS,
    );

    expect(billing).toContain("sales_order.billing_address_id then sales_order.created_by");
    expect(shipping).toContain("sales_order.shipping_address_id then sales_order.created_by");
    expect(billing).not.toBe(shipping);
  });

  it("leaves a single hop to the label, which already names its columns", () => {
    const direct: JoinPlan = {
      startIndex: 0,
      startOid: ADDRESS.oid,
      targetOid: SALES_ORDER.oid,
      viaOids: [],
      hops: [
        {
          foreignKey: foreignKey(SALES_ORDER.oid, ["billing_address_id"], ADDRESS.oid),
          fromOid: ADDRESS.oid,
          toOid: SALES_ORDER.oid,
        },
      ],
    };

    expect(joinPlanDescription(direct, [START], OBJECTS)).not.toContain(" on ");
  });
});
