import { describe, expect, it } from "vitest";
import {
  parseWorkbenchGraphDrag,
  serializeWorkbenchGraphDrag,
  type WorkbenchGraphObjectDragPayload,
} from "./dragAndDrop.js";

const payload: WorkbenchGraphObjectDragPayload = {
  version: 1,
  availability: "accepted",
  connectionId: "connection",
  database: "demo",
  sourceUri: "postgresql://connection/demo/shop/table/orders.sql",
  symbolUri: "code+moniker://orders",
  kind: "table",
  label: "shop.orders",
};

describe("Workbench graph drag payload", () => {
  it("round-trips an accepted graph object through the private JSON payload", () => {
    expect(parseWorkbenchGraphDrag(serializeWorkbenchGraphDrag(payload))).toEqual(payload);
  });

  it("rejects unknown graph kinds and foreign URI schemes", () => {
    expect(parseWorkbenchGraphDrag(JSON.stringify({ ...payload, kind: "column" }))).toBeUndefined();
    expect(parseWorkbenchGraphDrag("file:///tmp/orders.sql")).toBeUndefined();
  });
});
