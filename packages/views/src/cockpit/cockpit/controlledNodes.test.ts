import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { reconcileControlledNodes } from "./controlledNodes.js";

interface TestNodeData extends Record<string, unknown> {
  label: string;
}

function node(
  id: string,
  position: { x: number; y: number },
  data: TestNodeData,
): Node<TestNodeData> {
  return { id, position, data };
}

describe("controlled cockpit nodes", () => {
  it("preserves interactive state while applying external presentation updates", () => {
    const current = {
      ...node("orders", { x: 120, y: 80 }, { label: "orders" }),
      dragging: true,
      selected: true,
      measured: { width: 220, height: 70 },
    };
    const updated = {
      ...node("orders", { x: 0, y: 0 }, { label: "archived orders" }),
      className: "is-on-path",
    };

    expect(reconcileControlledNodes([current], [updated], false)).toEqual([
      {
        ...current,
        ...updated,
        position: current.position,
        dragging: true,
        selected: true,
      },
    ]);
  });

  it("uses the external layout when the focus or perspective changes", () => {
    const current = {
      ...node("orders", { x: 120, y: 80 }, { label: "orders" }),
      dragging: true,
      selected: true,
    };
    const updated = node("orders", { x: 10, y: 20 }, { label: "orders" });

    expect(reconcileControlledNodes([current], [updated], true)).toEqual([updated]);
  });
});
