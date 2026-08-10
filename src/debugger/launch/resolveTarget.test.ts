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
});
