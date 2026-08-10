import { describe, expect, it } from "vitest";
import type {
  CodeMonikerGraphResult,
  CodeMonikerSymbol,
} from "../../src/workbench/localCodeMoniker.js";
import {
  buildWorkbenchRelationGroups,
  classifyWorkbenchRelationFailure,
  isWorkbenchRelationSnapshotCurrent,
} from "./workbenchRelations.js";

const DATABASE = {
  serverId: "localhost:5433/testdb:postgres",
  database: "testdb",
};

const EMPTY_GRAPH_METADATA = {
  coverage: {
    callers: { matching: 0, returned: 0, total: 0 },
    callees: { matching: 0, returned: 0, total: 0 },
    internal_edges: { matching: 0, returned: 0, total: 0 },
    members: { matching: 0, returned: 0, total: 0 },
  },
  unlinked: { external: 0, manifest_blocked: 0, unresolved: 0 },
};

// This fixture builder mirrors CodeMonikerSymbol fields directly to keep scenario call sites clear.
// code-moniker: ignore[smell-long-parameter-list]
function symbol(
  name: string,
  kind: string,
  schema: string,
  documentKind: string,
  oid: number,
  database = DATABASE.database,
  ownerName = name,
): CodeMonikerSymbol {
  const sourceName = kind === "function" || kind === "procedure" ? `${ownerName}()` : ownerName;
  return {
    uri:
      `code+moniker://./srcset:test/lang:sql/dir:${schema}/dir:${documentKind}/` +
      `module:${sourceName}/schema:${schema}/${kind}:${name}`,
    name,
    kind,
    file:
      `postgresql://${encodeURIComponent(DATABASE.serverId)}/${database}/` +
      `${schema}/${documentKind}/${encodeURIComponent(sourceName)}.sql`,
    signature: "",
    postgres: {
      ...DATABASE,
      database,
      schema,
      documentKind: documentKind as "table" | "routine",
      oid,
      name: ownerName,
      signature: "",
    },
  };
}

describe("Workbench focused relations", () => {
  it("groups direct Code Moniker neighbors by relation and direction", () => {
    const orders = symbol("orders", "table", "sales", "table", 20);
    const refresh = symbol("refresh_orders", "function", "sales", "routine", 30);
    const caller = symbol("run_refresh", "procedure", "jobs", "routine", 31);
    const foreign = symbol("foreign_orders", "table", "sales", "table", 40, "another");
    const graph: CodeMonikerGraphResult = {
      ...EMPTY_GRAPH_METADATA,
      focus: { kind: "symbol", symbol: refresh },
      callers: [
        { count: 1, kinds: ["calls"], symbol: caller },
        { count: 1, kinds: ["reads"], symbol: foreign },
      ],
      callees: [
        { count: 2, kinds: ["reads", "writes"], symbol: orders },
        { count: 1, kinds: ["calls"], symbol: refresh },
      ],
    };

    expect(
      buildWorkbenchRelationGroups(graph, DATABASE).map((group) => ({
        relation: group.relation,
        direction: group.direction,
        targets: group.targets.map((target) => ({
          name: target.object?.name,
          count: target.count,
        })),
      })),
    ).toEqual([
      {
        relation: "calls",
        direction: "outgoing",
        targets: [{ name: "refresh_orders", count: 1 }],
      },
      {
        relation: "calls",
        direction: "incoming",
        targets: [{ name: "run_refresh", count: 1 }],
      },
      {
        relation: "reads",
        direction: "outgoing",
        targets: [{ name: "orders", count: 2 }],
      },
      {
        relation: "writes",
        direction: "outgoing",
        targets: [{ name: "orders", count: 2 }],
      },
    ]);
  });

  it("keeps a resolved object with no direct relations distinct from an error", () => {
    const focus = symbol("isolated", "table", "public", "table", 50);
    expect(
      buildWorkbenchRelationGroups(
        {
          ...EMPTY_GRAPH_METADATA,
          focus: { kind: "symbol", symbol: focus },
          callers: [],
          callees: [],
        },
        DATABASE,
      ),
    ).toEqual([]);
  });

  it("merges table and column facts into one semantic relation target", () => {
    const orders = symbol("orders", "table", "sales", "table", 20);
    const customer = symbol("customer", "table", "sales", "table", 21);
    const customerId = symbol("id", "column", "sales", "table", 21, DATABASE.database, "customer");
    customerId.signature = "bigint";
    const groups = buildWorkbenchRelationGroups(
      {
        ...EMPTY_GRAPH_METADATA,
        focus: { kind: "symbol", symbol: orders },
        callers: [],
        callees: [
          { count: 1, kinds: ["references"], symbol: customer },
          { count: 1, kinds: ["references"], symbol: customerId },
        ],
      },
      DATABASE,
      [orders, customer, customerId],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets).toEqual([
      expect.objectContaining({
        object: expect.objectContaining({ name: "customer" }),
        count: 2,
        members: [{ kind: "column", name: "id", signature: "bigint" }],
      }),
    ]);
  });

  it("resolves raw graph neighbors through the canonical indexed symbols", () => {
    const trigger = symbol("account_audit", "trigger", "sales", "trigger", 60);
    const routine = symbol(
      "audit_account()",
      "function",
      "sales",
      "routine",
      61,
      DATABASE.database,
      "audit_account",
    );
    const rawRoutine = { ...routine, postgres: undefined };
    const groups = buildWorkbenchRelationGroups(
      {
        ...EMPTY_GRAPH_METADATA,
        focus: { kind: "symbol", symbol: trigger },
        callers: [],
        callees: [{ count: 1, kinds: ["calls"], symbol: rawRoutine }],
      },
      DATABASE,
      [trigger, routine],
    );

    expect(groups).toEqual([
      expect.objectContaining({
        relation: "calls",
        direction: "outgoing",
        targets: [
          expect.objectContaining({
            symbol: routine,
            object: expect.objectContaining({ name: "audit_account", kind: "function" }),
          }),
        ],
      }),
    ]);
  });

  it("classifies missing, ambiguous, error, and stale generation outcomes", () => {
    expect(classifyWorkbenchRelationFailure("symbol_not_found")).toBe("missing");
    expect(classifyWorkbenchRelationFailure("ambiguous symbol focus")).toBe("ambiguous");
    expect(classifyWorkbenchRelationFailure("socket closed")).toBe("error");
    expect(isWorkbenchRelationSnapshotCurrent(12, 12, true)).toBe(true);
    expect(isWorkbenchRelationSnapshotCurrent(13, 12, true)).toBe(false);
    expect(isWorkbenchRelationSnapshotCurrent(12, 12, false)).toBe(false);
  });
});
