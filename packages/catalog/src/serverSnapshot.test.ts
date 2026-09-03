import { describe, expect, it, vi } from "vitest";
import { readPostgresServerSnapshot } from "./serverSnapshot.js";

describe("PostgreSQL server snapshot", () => {
  it("reports the total client count independently from the limited session details", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_postmaster_start_time")) {
        return {
          rows: [
            {
              version: "PostgreSQL 17",
              started_at: new Date("2026-09-03T10:00:00Z"),
              encoding: "UTF8",
              timezone: "Etc/UTC",
              max_connections: "200",
            },
          ],
        };
      }
      if (sql.includes("pg_stat_activity")) {
        expect(sql).toContain("count(*) OVER () AS total_count");
        expect(sql).toContain("LIMIT 100");
        return {
          rows: [
            {
              pid: 42,
              usename: "postgres",
              datname: "demo",
              application_name: "postgresql-workbench",
              state: "active",
              client_addr: "127.0.0.1",
              backend_start: new Date("2026-09-03T10:01:00Z"),
              xact_start: null,
              query_start: null,
              wait_event_type: null,
              wait_event: null,
              query: "SELECT 1",
              total_count: "142",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const snapshot = await readPostgresServerSnapshot({ query } as never);

    expect(snapshot.currentConnections).toBe(142);
    expect(snapshot.sessions).toHaveLength(1);
  });
});
