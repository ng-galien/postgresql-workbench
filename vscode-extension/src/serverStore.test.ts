import { describe, expect, it } from "vitest";
import { ServerStore, sameDatabaseContextIdentity } from "./serverStore.js";

const CONTEXT = {
  host: "localhost",
  port: 5432,
  database: "app",
  user: "postgres",
};

describe("database context identity", () => {
  it.each(["host", "port", "database", "user"] as const)(
    "treats %s changes as a different context",
    (field) => {
      const value = field === "port" ? 5433 : "other";
      expect(sameDatabaseContextIdentity(CONTEXT, { ...CONTEXT, [field]: value })).toBe(false);
    },
  );

  it("does not include credentials or SSL presentation in the database identity", () => {
    expect(sameDatabaseContextIdentity(CONTEXT, { ...CONTEXT })).toBe(true);
  });
});

describe("ServerStore schema synchronization overrides", () => {
  it("persists explicit DatabaseContext settings without storing them as secrets", async () => {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const store = new ServerStore({
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
    const server = {
      id: "localhost:5432/app:postgres",
      name: "postgres@localhost:5432/app",
      ...CONTEXT,
      schemaSync: { enabled: true, supportSchema: "project_workbench" },
    };

    await store.add(server, "secret");

    expect(store.get(server.id)?.schemaSync).toEqual({
      enabled: true,
      supportSchema: "project_workbench",
    });
    expect(await store.getPassword(server.id)).toBe("secret");
    expect(JSON.stringify(state.get("postgresql-workbench.servers"))).not.toContain("secret");
  });
});
