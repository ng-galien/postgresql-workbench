import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  DataTransferItem: class {
    constructor(readonly value: unknown) {}
  },
}));

import {
  parseSqlAuthoringDrag,
  SQL_AUTHORING_OBJECT_MIME,
} from "../../../packages/sql/src/snapshot.js";
import {
  WORKBENCH_GRAPH_OBJECT_MIME,
  WORKBENCH_GRAPH_UNSUPPORTED_MIME,
} from "../../../packages/views/src/cockpit/dragAndDrop.js";
import type { PlpgsqlTreeItem } from "./tree.js";
import {
  dragPayload,
  sqlAuthoringDragPayload,
  WorkbenchTreeDragAndDropController,
} from "./treeDragAndDrop.js";

const object = {
  symbolUri: "code+moniker://orders",
  sourceUri: "postgresql://connection/demo/shop/table/orders.sql",
  connectionId: "connection",
  database: "demo",
  schema: "shop",
  oid: 42,
  name: "orders",
  kind: "table" as const,
  signature: "",
  params: [],
  plpgsql: false,
};

describe("Workbench TreeView graph dragging", () => {
  it("accepts exactly one top-level object projected by the graph model", () => {
    expect(dragPayload([{ kind: "object", object } as unknown as PlpgsqlTreeItem])).toEqual({
      version: 1,
      availability: "accepted",
      connectionId: "connection",
      database: "demo",
      sourceUri: object.sourceUri,
      symbolUri: object.symbolUri,
      kind: "table",
      label: "shop.orders",
    });
  });

  it("explains why table members and schemas cannot be dropped", () => {
    expect(
      dragPayload([
        {
          kind: "tableMember",
          member: { name: "customer_id" },
          object,
        } as unknown as PlpgsqlTreeItem,
      ]),
    ).toMatchObject({
      availability: "unsupported",
      reason: expect.stringContaining("parent table"),
    });
    expect(dragPayload([{ kind: "schema", schema: "shop" } as PlpgsqlTreeItem])).toMatchObject({
      availability: "unsupported",
      reason: expect.stringContaining("not graph nodes"),
    });
  });

  it("keeps SQL authoring table and column payloads separate from graph semantics", () => {
    expect(
      sqlAuthoringDragPayload([{ kind: "object", object } as unknown as PlpgsqlTreeItem]),
    ).toEqual({
      kind: "table",
      connectionId: "connection",
      database: "demo",
      oid: 42,
      schema: "shop",
      name: "orders",
    });
    expect(
      sqlAuthoringDragPayload([
        {
          kind: "tableMember",
          member: { kind: "column", name: "customer_id" },
          object,
        } as unknown as PlpgsqlTreeItem,
      ]),
    ).toEqual({
      kind: "column",
      connectionId: "connection",
      database: "demo",
      tableOid: 42,
      tableSchema: "shop",
      tableName: "orders",
      name: "customer_id",
    });
    expect(
      sqlAuthoringDragPayload([
        {
          kind: "object",
          object: {
            ...object,
            oid: 43,
            name: "reprice_order",
            kind: "procedure",
            params: [{ name: "order_id", type: "bigint" }],
          },
        } as unknown as PlpgsqlTreeItem,
      ]),
    ).toEqual({
      kind: "procedure",
      connectionId: "connection",
      database: "demo",
      oid: 43,
      schema: "shop",
      name: "reprice_order",
    });
    expect(
      sqlAuthoringDragPayload([
        {
          kind: "object",
          object: {
            ...object,
            oid: 44,
            name: "product_stock_audit",
            kind: "trigger",
          },
        } as unknown as PlpgsqlTreeItem,
      ]),
    ).toEqual({
      kind: "trigger",
      connectionId: "connection",
      database: "demo",
      oid: 44,
      schema: "shop",
      name: "product_stock_audit",
    });
  });

  it("does not advertise graph dragging for connections or scratchpads", () => {
    expect(dragPayload([{ kind: "connection" } as PlpgsqlTreeItem])).toBeUndefined();
    expect(dragPayload([{ kind: "sqlNotebook" } as PlpgsqlTreeItem])).toBeUndefined();
  });

  it("publishes the real TreeView drag MIME contract for accepted and rejected items", () => {
    const announce = vi.fn();
    const controller = new WorkbenchTreeDragAndDropController(announce);
    const accepted = transfer();
    controller.handleDrag([{ kind: "object", object } as unknown as PlpgsqlTreeItem], accepted.api);
    expect(accepted.values.has(WORKBENCH_GRAPH_OBJECT_MIME)).toBe(true);
    expect(parseSqlAuthoringDrag(String(accepted.values.get(SQL_AUTHORING_OBJECT_MIME)))).toEqual({
      kind: "table",
      connectionId: "connection",
      database: "demo",
      oid: 42,
      schema: "shop",
      name: "orders",
    });
    expect(accepted.values.get("text/plain")).toBe("shop.orders");
    expect(accepted.values.has("text/uri-list")).toBe(false);
    expect(controller.activePayload(false)).toMatchObject({ symbolUri: object.symbolUri });
    expect(announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbolUri: object.symbolUri }),
    );
    expect(controller.activePayload(true)).toMatchObject({ symbolUri: object.symbolUri });
    expect(controller.activePayload(false)).toBeUndefined();
    expect(announce).toHaveBeenLastCalledWith(null);

    const rejected = transfer();
    controller.handleDrag([{ kind: "schema", schema: "shop" } as PlpgsqlTreeItem], rejected.api);
    expect(rejected.values.has(SQL_AUTHORING_OBJECT_MIME)).toBe(false);
    expect(rejected.values.has(WORKBENCH_GRAPH_UNSUPPORTED_MIME)).toBe(true);
    expect(rejected.values.get("text/plain")).toBe("shop");
    expect(rejected.values.has("text/uri-list")).toBe(false);
    expect(announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ availability: "unsupported" }),
    );
    controller.dispose();
    expect(announce).toHaveBeenLastCalledWith(null);
  });

  it("adds a neutral URI transport only when a Workbench destination owns the gesture", () => {
    const controller = new WorkbenchTreeDragAndDropController(
      undefined,
      () => "postgresql-workbench-drag:/source/test",
    );
    const accepted = transfer();
    controller.handleDrag([{ kind: "object", object } as unknown as PlpgsqlTreeItem], accepted.api);
    expect(accepted.values.get("text/uri-list")).toBe("postgresql-workbench-drag:/source/test");
  });

  it("does not clear a newer same-object preview when an older gesture completes", () => {
    const announce = vi.fn();
    const handoffIds: string[] = [];
    const controller = new WorkbenchTreeDragAndDropController(announce, (handoffId) => {
      handoffIds.push(handoffId);
      return `postgresql-workbench-drag:/handoff/${handoffId}`;
    });
    controller.handleDrag(
      [{ kind: "object", object } as unknown as PlpgsqlTreeItem],
      transfer().api,
    );
    controller.handleDrag(
      [{ kind: "object", object } as unknown as PlpgsqlTreeItem],
      transfer().api,
    );

    expect(handoffIds).toHaveLength(2);
    expect(handoffIds[0]).not.toBe(handoffIds[1]);
    controller.completeHandoff(handoffIds[0]);

    expect(controller.activePayload(false)).toMatchObject({ symbolUri: object.symbolUri });
    expect(controller.activeAuthoringPayload(false)).toMatchObject({ oid: object.oid });
    expect(announce).not.toHaveBeenLastCalledWith(null);

    controller.completeHandoff(handoffIds[1]);
    expect(controller.activePayload(false)).toBeUndefined();
    expect(controller.activeAuthoringPayload(false)).toBeUndefined();
    expect(announce).toHaveBeenLastCalledWith(null);
  });
});

function transfer() {
  const values = new Map<string, unknown>();
  return {
    values,
    api: {
      set(mime: string, item: { value: unknown }) {
        values.set(mime, item.value);
      },
    } as never,
  };
}
