import { describe, expect, it } from "vitest";
import { GraphNavigation } from "./navigation.js";

describe("Graph navigation", () => {
  it("keeps back and forward history independently from the VS Code panel", () => {
    const navigation = new GraphNavigation();
    navigation.reset("database");
    navigation.push("schema");
    navigation.push("table");

    expect(navigation.depth).toBe(2);
    expect(navigation.move(-1)).toBe("schema");
    expect(navigation.canBack).toBe(true);
    expect(navigation.canForward).toBe(true);
    expect(navigation.move(1)).toBe("table");
  });

  it("restores a checkpoint when loading a destination fails", () => {
    const navigation = new GraphNavigation();
    navigation.reset("database");
    navigation.push("schema");
    const checkpoint = navigation.snapshot();

    navigation.push("missing");
    navigation.restore(checkpoint);

    expect(navigation.current).toBe("schema");
    expect(navigation.canForward).toBe(false);
  });

  it("restores the accumulated exploration state with back and forward", () => {
    const navigation = new GraphNavigation<{ nodes: string[] }>();
    navigation.reset("orders");
    navigation.setState({ nodes: ["orders", "customer"] });
    navigation.push("customer");
    navigation.setState({ nodes: ["orders", "customer", "address"] });

    expect(navigation.move(-1)).toBe("orders");
    expect(navigation.currentState?.nodes).toEqual(["orders", "customer"]);
    expect(navigation.move(1)).toBe("customer");
    expect(navigation.currentState?.nodes).toEqual(["orders", "customer", "address"]);
  });

  it("keeps same-focus expansion checkpoints undoable", () => {
    const navigation = new GraphNavigation<{ nodes: string[] }>();
    navigation.reset("orders");
    navigation.setState({ nodes: ["orders", "customer"] });
    navigation.checkpoint({ nodes: ["orders", "customer", "address"] });

    expect(navigation.current).toBe("orders");
    expect(navigation.currentState?.nodes).toEqual(["orders", "customer", "address"]);
    expect(navigation.move(-1)).toBe("orders");
    expect(navigation.currentState?.nodes).toEqual(["orders", "customer"]);
    expect(navigation.move(1)).toBe("orders");
    expect(navigation.currentState?.nodes).toEqual(["orders", "customer", "address"]);
  });
});
