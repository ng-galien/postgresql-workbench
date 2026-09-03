import { describe, expect, it } from "vitest";
import { debuggableSqlCall, debuggableSqlDefinition } from "./sqlDebugAvailability.js";

const snapshot = {
  status: "available" as const,
  connectionId: "demo",
  database: "demo",
  revision: "one",
  generation: 1,
  foreignKeys: [],
  objects: [
    {
      connectionId: "demo",
      database: "demo",
      schema: "playground",
      oid: 1,
      name: "fib",
      kind: "function" as const,
      signature: "n:int4",
      plpgsql: true,
      parameters: [{ name: "n", type: "int4" }],
      columns: [],
    },
    {
      connectionId: "demo",
      database: "demo",
      schema: "pg_catalog",
      oid: 2,
      name: "now",
      kind: "function" as const,
      signature: "",
      plpgsql: false,
      parameters: [],
      columns: [],
    },
    {
      connectionId: "demo",
      database: "demo",
      schema: "playground",
      oid: 3,
      name: "mixed",
      kind: "function" as const,
      signature: "n:int4",
      plpgsql: true,
      parameters: [{ name: "n", type: "int4" }],
      columns: [],
    },
    {
      connectionId: "demo",
      database: "demo",
      schema: "playground",
      oid: 4,
      name: "mixed",
      kind: "function" as const,
      signature: "value:text",
      plpgsql: false,
      parameters: [{ name: "value", type: "text" }],
      columns: [],
    },
  ],
};

describe("SQL debug availability", () => {
  it("offers Debug only for one resolved PL/pgSQL call target", () => {
    expect(
      debuggableSqlCall(snapshot, {
        schema: "playground",
        routine: "fib",
        args: ["10"],
        sql: "SELECT playground.fib(10)",
        isLaunchable: true,
        line: 1,
        kind: "select",
      }),
    ).toMatchObject({ status: "available" });
    expect(
      debuggableSqlCall(snapshot, {
        schema: "pg_catalog",
        routine: "now",
        args: [],
        sql: "SELECT pg_catalog.now()",
        isLaunchable: true,
        line: 1,
        kind: "select",
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("offers definition Debug only for the exact indexed PL/pgSQL overload", () => {
    expect(
      debuggableSqlDefinition(snapshot, {
        schema: "playground",
        name: "fib",
        params: [{ name: "n", type: "integer", mode: "in" }],
        line: 1,
        kind: "function",
      }),
    ).toMatchObject({ status: "available" });
    expect(
      debuggableSqlDefinition(snapshot, {
        schema: "playground",
        name: "fib",
        params: [],
        line: 1,
        kind: "function",
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("does not guess a PL/pgSQL overload from name and arity alone", () => {
    expect(
      debuggableSqlCall(snapshot, {
        schema: "playground",
        routine: "mixed",
        args: ["'text'"],
        sql: "SELECT playground.mixed('text')",
        isLaunchable: true,
        line: 1,
        kind: "select",
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("does not guess a schema for an unqualified routine definition", () => {
    const ambiguousSnapshot = {
      ...snapshot,
      objects: [
        ...snapshot.objects,
        {
          ...snapshot.objects[0]!,
          oid: 5,
          schema: "archive",
          plpgsql: false,
        },
      ],
    };
    expect(
      debuggableSqlDefinition(ambiguousSnapshot, {
        schema: null,
        name: "fib",
        params: [{ name: "n", type: "integer", mode: "in" }],
        line: 1,
        kind: "function",
      }),
    ).toMatchObject({ status: "unavailable" });
  });
});
