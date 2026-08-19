import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { FunctionDefinition } from "../../../packages/sql/src/callParser.js";
import {
  compareRoutineSource,
  resolveRoutineOid,
  routineRegprocedureIdentity,
} from "./compareSource.js";

describe("routine source comparison", () => {
  it("builds the exact overloaded routine identity", () => {
    const definition = {
      schema: "app",
      name: "find_item",
      params: [
        { name: "id", type: "int4", mode: "in" },
        { name: "label", type: "text", mode: "inout" },
      ],
      line: 1,
      kind: "function",
    } satisfies FunctionDefinition;

    expect(routineRegprocedureIdentity(definition)).toBe('"app"."find_item"(int4, text)');
  });

  it("compares body source independently from canonical DDL wrapping", async () => {
    const localBody = `
      BEGIN
        RETURN 42;
      END;
    `;
    const deployedBody = `
      BEGIN
        RETURN 42;
      END;
    `;

    await expect(compareRoutineSource(localBody, deployedBody)).resolves.toBe("identical");
    await expect(
      compareRoutineSource(localBody, deployedBody.replace("RETURN 42", "RETURN 43")),
    ).resolves.toBe("different");
    await expect(compareRoutineSource(undefined, deployedBody)).resolves.toBe("unavailable");
  });

  it("preserves array dimensions for variadic identities", () => {
    const definition = {
      schema: "app",
      name: "collect",
      params: [{ name: "items", type: "int4[]", mode: "variadic" }],
      line: 1,
      kind: "function",
    } satisfies FunctionDefinition;

    expect(routineRegprocedureIdentity(definition)).toBe('"app"."collect"(int4[])');
  });

  it("lets PostgreSQL resolve aliases and qualifications to one routine OID", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [{ oid: "4294967294" }] };
      },
    } as unknown as Client;

    await expect(resolveRoutineOid(client, '"app"."find_item"(int4, text)')).resolves.toBe(
      4_294_967_294,
    );
    expect(calls).toEqual([
      {
        text: "SELECT to_regprocedure($1)::oid::bigint::text AS oid",
        values: ['"app"."find_item"(int4, text)'],
      },
    ]);

    const missing = {
      async query() {
        return { rows: [{ oid: null }] };
      },
    } as unknown as Client;
    await expect(resolveRoutineOid(missing, '"app"."missing"()')).resolves.toBeUndefined();
  });
});
