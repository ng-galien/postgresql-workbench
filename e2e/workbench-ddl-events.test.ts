import { Client, type Notification } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorkbenchDdlProvisioningSql,
  buildWorkbenchDdlRemovalSql,
  parsePostgresDdlNotification,
  WORKBENCH_DDL_CHANNEL,
  workbenchDdlProvisioningStatusSql,
} from "../src/workbench/postgresDdlSync.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const DATABASE = "plpgsql_workbench_ddl_events_e2e";

describe("e2e: Workbench DDL event delivery", () => {
  let admin: Client;
  let postgres: Client;
  let listener: Client | undefined;

  beforeAll(async () => {
    admin = new Client(PG_CONFIG);
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    postgres = new Client({ ...PG_CONFIG, database: DATABASE });
    await postgres.connect();
  }, 30_000);

  afterAll(async () => {
    if (listener) await listener.end().catch(() => undefined);
    if (postgres) {
      await postgres.query(buildWorkbenchDdlRemovalSql("workbench")).catch(() => undefined);
      await postgres.end().catch(() => undefined);
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("keeps provisioning across listener opt-out and reports public schema DDL after opt-in", async () => {
    await postgres.query(buildWorkbenchDdlProvisioningSql("workbench"));
    await postgres.query(buildWorkbenchDdlProvisioningSql("workbench"));

    listener = await startListener();
    await listener.end();
    listener = undefined;

    const status = await postgres.query(workbenchDdlProvisioningStatusSql("workbench"));
    expect(status.rows[0]).toMatchObject({
      schema_exists: true,
      ddl_function_exists: true,
      drop_function_exists: true,
      ddl_trigger_exists: true,
      drop_trigger_exists: true,
    });

    listener = await startListener();
    const created = await executeAndWait("CREATE TABLE public.ddl_sync_probe (id bigint)");
    expect(created.event).toBe("ddl_command_end");
    expect(created.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: "table",
          schemaName: "public",
          objectIdentity: "public.ddl_sync_probe",
        }),
      ]),
    );

    const altered = await executeAndWait("ALTER TABLE public.ddl_sync_probe ADD COLUMN label text");
    expect(altered.objects.some((object) => object.objectIdentity.includes("ddl_sync_probe"))).toBe(
      true,
    );

    const dropped = await executeAndWait("DROP TABLE public.ddl_sync_probe");
    expect(dropped.event).toBe("sql_drop");
    expect(
      dropped.objects.some(
        (object) =>
          object.objectType === "table" && object.objectIdentity === "public.ddl_sync_probe",
      ),
    ).toBe(true);
  }, 30_000);

  async function startListener(): Promise<Client> {
    const client = new Client({ ...PG_CONFIG, database: DATABASE });
    await client.connect();
    await client.query(`LISTEN ${WORKBENCH_DDL_CHANNEL}`);
    return client;
  }

  async function executeAndWait(sql: string) {
    if (!listener) throw new Error("DDL listener is not active");
    const notification = new Promise<Notification>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`DDL notification did not arrive within 5000 ms for: ${sql}`)),
        5_000,
      );
      listener?.once("notification", (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    await postgres.query(sql);
    const received = await notification;
    if (received.channel !== WORKBENCH_DDL_CHANNEL || !received.payload) {
      throw new Error(`Unexpected PostgreSQL notification on ${received.channel}`);
    }
    return parsePostgresDdlNotification(received.payload);
  }
});
