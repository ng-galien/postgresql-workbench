import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionService } from "../vscode-extension/src/connection/connectPostgres.js";
import { PostgresConnectionRegistry } from "../vscode-extension/src/connection/registry.js";

const ADMIN_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const DATABASE_A = "pgwb_connection_it_a";
const DATABASE_B = "pgwb_connection_it_b";

describe("e2e: independent PostgreSQL Connexions", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client(ADMIN_CONFIG);
    await admin.connect();
    for (const database of [DATABASE_A, DATABASE_B]) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
    }
    const debuggerDatabase = new Client({ ...ADMIN_CONFIG, database: DATABASE_A });
    await debuggerDatabase.connect();
    await debuggerDatabase.query("CREATE EXTENSION pldbgapi");
    await debuggerDatabase.end();
  }, 30_000);

  afterAll(async () => {
    for (const database of [DATABASE_A, DATABASE_B]) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end();
  });

  it("keeps A and B alive and disconnects only the exact Connexion", async () => {
    const registry = new PostgresConnectionRegistry();
    const open = (database: string, applicationName: string) => async () => {
      const client = new Client({
        ...ADMIN_CONFIG,
        database,
        application_name: applicationName,
      });
      await client.connect();
      return client;
    };

    const clientA = await registry.connect("A", open(DATABASE_A, "pgwb_connection_it_a"));
    const clientB = await registry.connect("B", open(DATABASE_B, "pgwb_connection_it_b"));
    const pidA = Number((await clientA.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    const pidB = Number((await clientB.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);

    expect(registry.connectedIds).toEqual(["A", "B"]);
    expect(registry.client("A")).toBe(clientA);
    expect(registry.client("B")).toBe(clientB);
    expect(Number((await clientA.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)).toBe(pidA);
    expect(Number((await clientB.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)).toBe(pidB);

    await expect(registry.disconnect("A", (client) => client.end())).resolves.toBe(true);
    expect(registry.isConnected("A")).toBe(false);
    expect(registry.isConnected("B")).toBe(true);
    await expect(clientB.query("SELECT current_database() AS database")).resolves.toMatchObject({
      rows: [{ database: DATABASE_B }],
    });

    await registry.dispose((client) => client.end());
  });

  it("detects debugger capability independently for each database", async () => {
    const output: string[] = [];
    const service = new ConnectionService({
      appendLine: (line: string) => output.push(line),
    } as never);
    const clientA = await service.connectClient({ ...ADMIN_CONFIG, database: DATABASE_A });
    const clientB = await service.connectClient({ ...ADMIN_CONFIG, database: DATABASE_B });
    try {
      await expect(service.checkRequirements(clientA, DATABASE_A)).resolves.toEqual({
        available: true,
        error: "",
      });
      await expect(service.checkRequirements(clientB, DATABASE_B)).resolves.toEqual({
        available: false,
        error: `pldbgapi extension not installed on "${DATABASE_B}".`,
      });
    } finally {
      await Promise.all([service.disconnect(clientA), service.disconnect(clientB)]);
    }
  });
});
