import { describe, expect, it } from "vitest";
import {
  classifyWorkbenchDdlSyncFailure,
  resolveWorkbenchDdlSyncConfiguration,
} from "./ddlSyncSettings.js";
import type { ConnectionConfig } from "./savedConnection.js";

const CONNECTION: ConnectionConfig = {
  id: "local:5432/app:postgres",
  name: "postgres@local:5432/app",
  host: "local",
  port: 5432,
  database: "app",
  user: "postgres",
};

describe("Workbench DDL synchronization configuration", () => {
  it("uses Settings defaults when the connection has no override", () => {
    expect(
      resolveWorkbenchDdlSyncConfiguration(CONNECTION, {
        enabled: false,
        supportSchema: "workbench",
      }),
    ).toEqual({
      enabled: false,
      supportSchema: "workbench",
      enabledSource: "settings",
      supportSchemaSource: "settings",
    });
  });

  it("gives explicit Connection overrides precedence over Settings", () => {
    expect(
      resolveWorkbenchDdlSyncConfiguration(
        { ...CONNECTION, schemaSync: { enabled: true, supportSchema: "project_workbench" } },
        { enabled: false, supportSchema: "workbench" },
      ),
    ).toMatchObject({
      enabled: true,
      supportSchema: "project_workbench",
      enabledSource: "connection",
      supportSchemaSource: "connection",
    });
  });

  it("rejects an unsafe support schema from a persisted connection override", () => {
    expect(() =>
      resolveWorkbenchDdlSyncConfiguration(
        { ...CONNECTION, schemaSync: { supportSchema: "Workbench; DROP SCHEMA public" } },
        { enabled: false, supportSchema: "workbench" },
      ),
    ).toThrow("lower-case, unquoted PostgreSQL identifier");
  });

  it("surfaces PostgreSQL insufficient-privilege errors distinctly", () => {
    expect(classifyWorkbenchDdlSyncFailure({ code: "42501" })).toBe("insufficient-privilege");
    expect(classifyWorkbenchDdlSyncFailure(new Error("connection refused"))).toBe("unavailable");
  });
});
