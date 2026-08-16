import { describe, expect, it } from "vitest";
import type { PostgresDebugger } from "../postgres/index.js";
import { resolveTargetExecution } from "./resolveTarget.js";

const backend = {} as PostgresDebugger;

describe("resolveTargetExecution", () => {
  it("resolves an OID-backed structured target without a syntax parser", async () => {
    const result = await resolveTargetExecution(
      backend,
      {
        routine: {
          oid: 42,
          schema: "shop",
          name: "place_order",
          kind: "function",
          argTypes: ["integer"],
        },
        routineArgs: [{ value: "7" }],
      },
      undefined,
    );

    expect(result.entryOid).toBe(42);
    expect(result.queryText).toBe('SELECT "shop"."place_order"($1::integer)');
  });

  it("requires stateless parsing only for a raw SQL target", async () => {
    await expect(
      resolveTargetExecution(backend, { sql: "SELECT shop.place_order(7)" }, undefined),
    ).rejects.toThrow(/syntax parser is required/);
  });

  it("executes a trigger harness while stopping in its bound entry routine", async () => {
    const sql = "UPDATE shop.product SET stock = stock WHERE id = 1";
    const result = await resolveTargetExecution(
      backend,
      {
        sql,
        entryRoutine: {
          oid: 84,
          schema: "shop",
          name: "audit_product_stock",
          kind: "function",
          argTypes: [],
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      entryOid: 84,
      queryText: sql,
      queryValues: [],
      routine: { oid: 84, schema: "shop", name: "audit_product_stock", kind: "function" },
    });
  });
});
