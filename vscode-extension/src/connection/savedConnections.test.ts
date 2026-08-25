import { describe, expect, it } from "vitest";
import {
  getConnectionName,
  getConnectionUrl,
  sameConnectionIdentity,
} from "../../../packages/catalog/src/savedConnection.js";
import { ConnectionStore } from "./savedConnections.js";

const CONTEXT = {
  host: "localhost",
  port: 5432,
  database: "app",
  user: "postgres",
};

describe("Connection identity", () => {
  it.each(["host", "port", "database", "user"] as const)(
    "treats %s changes as a different context",
    (field) => {
      const value = field === "port" ? 5433 : "other";
      expect(sameConnectionIdentity(CONTEXT, { ...CONTEXT, [field]: value })).toBe(false);
    },
  );

  it("does not include credentials or SSL presentation in the database identity", () => {
    expect(sameConnectionIdentity(CONTEXT, { ...CONTEXT })).toBe(true);
  });
});

describe("ConnectionStore schema synchronization overrides", () => {
  it("persists explicit Connection settings without storing them as secrets", async () => {
    const { state, store } = storeFixture();
    const connection = {
      id: "localhost:5432/app:postgres",
      name: "postgres@localhost:5432/app",
      ...CONTEXT,
      schemaSync: { enabled: true, supportSchema: "project_workbench" },
    };

    await store.add(connection, "secret");

    expect(store.get(connection.id)?.schemaSync).toEqual({
      enabled: true,
      supportSchema: "project_workbench",
    });
    expect(await store.getPassword(connection.id)).toBe("secret");
    expect(JSON.stringify(state.get("postgresql-workbench.servers"))).not.toContain("secret");
  });
});

describe("Connection display identity", () => {
  const first = {
    id: "localhost:5432/app:postgres",
    host: "localhost",
    port: 5432,
    database: "app",
    user: "postgres",
  };

  it("uses the optional custom name and otherwise falls back to the canonical URL", () => {
    expect(getConnectionUrl(first)).toBe("postgres@localhost:5432/app");
    expect(getConnectionName(first)).toBe("postgres@localhost:5432/app");
    expect(getConnectionName({ ...first, name: "  Local ERP  " })).toBe("Local ERP");
  });

  it("rejects a duplicate URL instead of silently replacing the saved Connection", async () => {
    const { store } = storeFixture();
    await store.add(first, "first-secret");

    await expect(store.add({ ...first, name: "Duplicate" }, "second-secret")).rejects.toThrow(
      "Connection URL postgres@localhost:5432/app is already saved.",
    );
    expect(await store.getPassword(first.id)).toBe("first-secret");
  });

  it("keeps custom display names unique without case or surrounding-space ambiguity", async () => {
    const { store } = storeFixture();
    await store.add({ ...first, name: "ERP" }, "first-secret");
    const second = {
      ...first,
      id: "localhost:5433/reporting:postgres",
      port: 5433,
      database: "reporting",
      name: " erp ",
    };

    expect(store.isConnectionNameAvailable("ERP")).toBe(false);
    expect(store.isConnectionNameAvailable("ERP", first.id)).toBe(true);
    await expect(store.add(second, "second-secret")).rejects.toThrow(
      "Connection name erp is already used.",
    );
  });

  it("persists only a real custom name and supports removing it", async () => {
    const { store } = storeFixture();
    await store.add(first, "secret");
    expect(store.get(first.id)?.name).toBeUndefined();

    await store.update(first.id, { ...first, name: "ERP" });
    expect(getConnectionName(store.get(first.id)!)).toBe("ERP");

    await store.update(first.id, { ...first, name: "   " });
    expect(store.get(first.id)?.name).toBeUndefined();
    expect(getConnectionName(store.get(first.id)!)).toBe("postgres@localhost:5432/app");
  });
});

function storeFixture(): {
  state: Map<string, unknown>;
  secrets: Map<string, string>;
  store: ConnectionStore;
} {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const store = new ConnectionStore({
    globalState: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
    workspaceState: {
      get: <T>(key: string) => state.get(`workspace:${key}`) as T | undefined,
      update: async (key: string, value: unknown) => {
        state.set(`workspace:${key}`, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as never);
  return { state, secrets, store };
}
