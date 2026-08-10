import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../src/workbench/localCodeMoniker.js";
import { type CatalogQueryClient, readPostgresCatalog } from "../src/workbench/postgresCatalog.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const WORKBENCH_DATABASE = "plpgsql_workbench_u1_e2e";

const CODE_MONIKER_RUNTIME = resolve(
  process.env.CODE_MONIKER_RUNTIME ?? join(process.cwd(), "vscode-extension/runtime/code-moniker"),
);
const CODE_MONIKER_EXECUTABLE = process.platform === "win32" ? "code-moniker.exe" : "code-moniker";
const LOCAL_CODE_MONIKER_AVAILABLE =
  existsSync(join(CODE_MONIKER_RUNTIME, "manifest.json")) &&
  existsSync(join(CODE_MONIKER_RUNTIME, "client", "node.cjs")) &&
  existsSync(join(CODE_MONIKER_RUNTIME, "bin", CODE_MONIKER_EXECUTABLE));

if (process.env.REQUIRE_LOCAL_CODE_MONIKER === "1" && !LOCAL_CODE_MONIKER_AVAILABLE) {
  throw new Error(
    `Packaged Code Moniker runtime is required but unavailable in ${CODE_MONIKER_RUNTIME}`,
  );
}

describe.skipIf(!LOCAL_CODE_MONIKER_AVAILABLE)(
  "e2e: PostgreSQL catalog to local Code Moniker graph",
  () => {
    let admin: Client;
    let postgres: Client;
    let session: LocalCodeMonikerSession | undefined;
    let publishedSourceSet: string | undefined;
    let workspaceRoot: string;

    beforeAll(async () => {
      workspaceRoot = mkdtempSync(join(tmpdir(), "postgresql-workbench-u1-"));
      admin = new Client(PG_CONFIG);
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${WORKBENCH_DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${WORKBENCH_DATABASE}`);
      postgres = new Client({ ...PG_CONFIG, database: WORKBENCH_DATABASE });
      await postgres.connect();
      const debuggerExtension = await postgres.query(
        "SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pldbgapi'",
      );
      expect(debuggerExtension.rowCount).toBe(0);
      await postgres.query(`
        DROP SCHEMA IF EXISTS workbench_u1 CASCADE;
        CREATE SCHEMA workbench_u1;
        CREATE TABLE workbench_u1.owner (
          id bigint PRIMARY KEY,
          display_name text NOT NULL
        );
        CREATE TABLE workbench_u1.account (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          owner_id bigint NOT NULL REFERENCES workbench_u1.owner(id),
          active boolean NOT NULL DEFAULT true
        );
        CREATE TABLE workbench_u1.empty_marker ();
        CREATE VIEW workbench_u1.active_account AS
        SELECT account.id, account.owner_id
        FROM workbench_u1.account
        WHERE account.active;
        CREATE FUNCTION workbench_u1.audit_account()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $body$
        BEGIN
          RETURN NEW;
        END
        $body$;
        CREATE TRIGGER account_audit
        AFTER INSERT ON workbench_u1.account
        FOR EACH ROW EXECUTE FUNCTION workbench_u1.audit_account();
      `);
    }, 30_000);

    afterAll(async () => {
      if (session) {
        if (publishedSourceSet) {
          await session.client.sources.remove(publishedSourceSet).catch(() => undefined);
        }
        await session.dispose().catch(() => undefined);
      }
      if (postgres) {
        await postgres.query("DROP SCHEMA IF EXISTS workbench_u1 CASCADE").catch(() => undefined);
        await postgres.end().catch(() => undefined);
      }
      if (admin) {
        await admin
          .query(`DROP DATABASE IF EXISTS ${WORKBENCH_DATABASE} WITH (FORCE)`)
          .catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
      if (workspaceRoot) {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it("indexes relational definitions and exposes a traversable view-to-table relation", async () => {
      const snapshot = await readPostgresCatalog(catalogClient(postgres), {
        serverId: "e2e-local",
        database: WORKBENCH_DATABASE,
      });
      expect(snapshot.sourceSet.documents.length).toBeGreaterThanOrEqual(8);
      expect(snapshot.metrics.introspectionMs).toBeLessThan(10_000);

      session = await ensureLocalCodeMonikerWorkspace({
        runtimePath: CODE_MONIKER_RUNTIME,
        workspaceRoots: [workspaceRoot],
        clientName: "postgresql-workbench-u1-e2e",
      });
      await waitForWorkspaceReady(session);
      expect(session.metadata.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(session.metadata.source).toBe(
        `npm:@code-moniker/client@${session.metadata.packageVersion}+` +
          `@code-moniker/cli-${process.platform}-${process.arch}@${session.metadata.packageVersion}`,
      );
      expect(session.client.supportsCommand("workspace.source_set.replace")).toBe(true);
      expect(session.client.supportsQuery("symbol.graph")).toBe(true);

      const publicationStarted = performance.now();
      await session.client.sources.replace(snapshot.sourceSet);
      publishedSourceSet = snapshot.sourceSet.srcset;
      const publicationMs = performance.now() - publicationStarted;
      const indexingMs =
        snapshot.metrics.introspectionMs + snapshot.metrics.materializationMs + publicationMs;

      const symbols = await session.client.symbols.search(
        { text: "active_account", language: ["sql"] },
        { consistency: "stale_ok" },
      );
      const view = symbols.data.rows.find(
        (symbol) => symbol.name === "active_account" && symbol.kind === "view",
      );
      expect(view).toBeDefined();

      const graphStarted = performance.now();
      const graph = await session.client.graph.symbol(
        view?.uri ?? "",
        { relation: ["reads"] },
        { consistency: "stale_ok" },
      );
      const graphQueryMs = performance.now() - graphStarted;
      expect(graph.focus.symbol?.uri).toBe(view?.uri);
      expect(
        graph.callees.some(
          ({ kinds, symbol }) =>
            kinds.includes("reads") && symbol.kind === "table" && symbol.name === "account",
        ),
      ).toBe(true);

      const triggerSymbols = await session.client.symbols.search(
        { text: "account_audit", language: ["sql"], kind: ["trigger"] },
        { consistency: "stale_ok" },
      );
      const trigger = triggerSymbols.data.rows.find(
        (symbol) => symbol.name === "account_audit" && symbol.kind === "trigger",
      );
      expect(trigger).toBeDefined();
      const triggerGraph = await session.client.graph.symbol(
        trigger?.uri ?? "",
        { relation: ["calls"] },
        { consistency: "stale_ok" },
      );
      expect(
        triggerGraph.callees.some(
          ({ kinds, symbol }) =>
            kinds.includes("calls") &&
            symbol.kind === "function" &&
            symbol.name === "audit_account()",
        ),
      ).toBe(true);

      const auditRoutine = triggerGraph.callees.find(
        ({ symbol }) => symbol.kind === "function" && symbol.name === "audit_account()",
      )?.symbol;
      expect(auditRoutine).toBeDefined();
      const routineGraph = await session.client.graph.symbol(
        auditRoutine?.uri ?? "",
        { relation: ["calls"] },
        { consistency: "stale_ok" },
      );
      expect(
        routineGraph.callers.some(
          ({ kinds, symbol }) =>
            kinds.includes("calls") && symbol.kind === "trigger" && symbol.name === "account_audit",
        ),
      ).toBe(true);

      await postgres.query(`
        DROP VIEW workbench_u1.active_account;
        CREATE VIEW workbench_u1.current_account AS
        SELECT account.id, account.owner_id
        FROM workbench_u1.account
        WHERE account.active;
      `);
      const replacement = await readPostgresCatalog(catalogClient(postgres), {
        serverId: "e2e-local",
        database: WORKBENCH_DATABASE,
      });
      expect(replacement.sourceSet.srcset).toBe(snapshot.sourceSet.srcset);
      expect(replacement.sourceSet.revision).not.toBe(snapshot.sourceSet.revision);
      await session.client.sources.replace(replacement.sourceSet);

      const replaced = await session.client.symbols.search(
        { text: "active_account", language: ["sql"] },
        { consistency: "stale_ok" },
      );
      expect(replaced.data.rows.some((symbol) => symbol.name === "active_account")).toBe(false);
      const current = await session.client.symbols.search(
        { text: "current_account", language: ["sql"] },
        { consistency: "stale_ok" },
      );
      expect(current.data.rows.some((symbol) => symbol.name === "current_account")).toBe(true);

      process.stdout.write(
        `workbench U1 metrics: documents=${snapshot.metrics.documentCount} ` +
          `symbols=${symbols.data.total} introspection=${snapshot.metrics.introspectionMs.toFixed(1)}ms ` +
          `materialization=${snapshot.metrics.materializationMs.toFixed(1)}ms ` +
          `publication=${publicationMs.toFixed(1)}ms indexing=${indexingMs.toFixed(1)}ms ` +
          `graph=${graphQueryMs.toFixed(1)}ms\n`,
      );
    }, 90_000);
  },
);

function catalogClient(client: Client): CatalogQueryClient {
  return {
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      const result = await client.query(sql);
      return { rows: result.rows };
    },
  };
}

async function waitForWorkspaceReady(session: LocalCodeMonikerSession): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await session.client.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker workspace indexing failed");
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
  }
  throw new Error("Code Moniker workspace did not become ready within 30000ms");
}
