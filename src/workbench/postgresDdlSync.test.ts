import { describe, expect, it } from "vitest";
import {
  buildWorkbenchDdlProvisioningSql,
  buildWorkbenchDdlRemovalSql,
  coalescePostgresDdlNotifications,
  parsePostgresDdlNotification,
  validateSupportSchema,
  workbenchDdlProvisioningStatusSql,
} from "./postgresDdlSync.js";

describe("PostgreSQL Workbench DDL synchronization", () => {
  it("accepts only safe lower-case unquoted support schemas", () => {
    expect(validateSupportSchema("workbench_sync_2")).toBe("workbench_sync_2");
    for (const invalid of ["WorkBench", "public;drop schema public", "pg_workbench", "a-b", ""]) {
      expect(() => validateSupportSchema(invalid)).toThrow();
    }
  });

  it("builds qualified, explicit and reversible provisioning SQL", () => {
    const install = buildWorkbenchDdlProvisioningSql("workbench");
    const remove = buildWorkbenchDdlRemovalSql("workbench");
    const status = workbenchDdlProvisioningStatusSql("workbench");

    expect(install).toContain('CREATE SCHEMA IF NOT EXISTS "workbench"');
    expect(install).toContain('FUNCTION "workbench".notify_ddl_command_end()');
    expect(install).toContain("CREATE EVENT TRIGGER plpgsql_workbench_ddl_command_end");
    expect(install).toContain("SET search_path = pg_catalog");
    expect(install).toContain("pg_event_trigger_dropped_objects()");
    expect(install).toContain("'resource_kind', CASE command.classid");
    expect(install).toContain("'pg_catalog.pg_class'::pg_catalog.regclass THEN CASE");
    expect(install).not.toContain("command.schema_name IS DISTINCT FROM 'workbench'");
    expect(install).not.toContain("dropped.schema_name IS DISTINCT FROM 'workbench'");
    expect(install).toContain("command.objid IN");
    expect(install).toContain("dropped.object_identity IN");
    expect(install).toContain("'workbench.notify_sql_drop()'");
    expect(install).toContain("evtevent <> 'ddl_command_end'");
    expect(install).toContain("evttags IS NOT NULL");
    expect(install).not.toContain("CREATE TRIGGER");
    expect(remove).toContain("DROP EVENT TRIGGER plpgsql_workbench_ddl_command_end");
    expect(remove).not.toContain("CASCADE");
    expect(remove).toContain("postgresql-workbench-schema-sync:v1");
    expect(remove).not.toContain("DROP FUNCTION IF EXISTS");
    expect(status).toContain("pg_catalog.pg_event_trigger");
    expect(status).toContain("pg_catalog.obj_description");
    expect(status).toContain("evtevent = 'ddl_command_end'");
    expect(status).toContain("evttags IS NULL");
  });

  it("parses and coalesces notifications by database and transaction", () => {
    const ddl = parsePostgresDdlNotification(
      JSON.stringify({
        v: 1,
        db: 42,
        tx: "101",
        event: "ddl_command_end",
        objects: [
          {
            classid: 1259,
            objid: 9001,
            objsubid: 0,
            resource_kind: "relation",
            command_tag: "ALTER TABLE",
            object_type: "table",
            schema_name: "app",
            object_identity: "app.account",
          },
        ],
      }),
    );
    const drop = parsePostgresDdlNotification(
      JSON.stringify({
        v: 1,
        db: 42,
        tx: "101",
        event: "sql_drop",
        objects: [
          {
            classid: 1259,
            objid: 9002,
            objsubid: 0,
            object_type: "table",
            schema_name: "app",
            object_name: "old_account",
            object_identity: "app.old_account",
            original: true,
          },
        ],
      }),
    );
    const groups = coalescePostgresDdlNotifications([ddl, ddl, drop]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ databaseOid: 42, transactionId: "101", fallback: false });
    expect(groups[0]?.objects).toHaveLength(2);
    expect(groups[0]?.objects[0]?.resourceKind).toBe("relation");
  });
});
