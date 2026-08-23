import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, type Notification } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeMonikerSymbol } from "../packages/catalog/src/localCodeMoniker.js";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../packages/catalog/src/localCodeMoniker.js";
import {
  buildPostgresSourceSet,
  type CatalogQueryClient,
  type PostgresCatalogObjectOrigin,
  readPostgresCatalog,
  readPostgresCatalogDocuments,
  type VirtualSqlDocument,
} from "../packages/catalog/src/postgresCatalog.js";
import {
  buildWorkbenchDdlProvisioningSql,
  buildWorkbenchDdlRemovalSql,
  type CoalescedPostgresDdlNotification,
  coalescePostgresDdlNotifications,
  type PostgresDdlNotification,
  parsePostgresDdlNotification,
  WORKBENCH_DDL_CHANNEL,
} from "../packages/catalog/src/postgresDdlSync.js";
import {
  buildPostgresResourceIndex,
  directPostgresDocumentUris,
  type IndexedPostgresResource,
} from "../packages/catalog/src/postgresSourceProvider.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const DATABASE = "plpgsql_workbench_ddl_sync_e2e";
const IDENTITY = { serverId: "ddl-sync-e2e", database: DATABASE };
const RUNTIME = resolve(
  process.env.CODE_MONIKER_RUNTIME ?? join(process.cwd(), "vscode-extension/runtime/code-moniker"),
);
const EXECUTABLE = process.platform === "win32" ? "code-moniker.exe" : "code-moniker";
const RUNTIME_AVAILABLE =
  existsSync(join(RUNTIME, "manifest.json")) &&
  existsSync(join(RUNTIME, "client", "node.cjs")) &&
  existsSync(join(RUNTIME, "bin", EXECUTABLE));

if (process.env.REQUIRE_LOCAL_CODE_MONIKER === "1" && !RUNTIME_AVAILABLE) {
  throw new Error(`Packaged Code Moniker runtime is required but unavailable in ${RUNTIME}`);
}

describe.skipIf(!RUNTIME_AVAILABLE)("e2e: Workbench DDL schema synchronization", () => {
  let admin: Client;
  let postgres: Client;
  let listener: Client;
  let session: LocalCodeMonikerSession;
  let workspaceRoot: string;
  let permissionErrorCode = "";
  let permissionSchemaExists = true;
  let documents = new Map<string, VirtualSqlDocument>();
  let origins = new Map<string, PostgresCatalogObjectOrigin>();
  let resources = new Map<string, IndexedPostgresResource>();
  const received: PostgresDdlNotification[] = [];

  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "postgresql-workbench-ddl-sync-"));
    admin = new Client(PG_CONFIG);
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.query("DROP ROLE IF EXISTS workbench_ddl_limited");
    await admin.query("CREATE ROLE workbench_ddl_limited LOGIN PASSWORD 'limited-password'");
    await admin.query(`GRANT CREATE ON DATABASE ${DATABASE} TO workbench_ddl_limited`);
    postgres = new Client({ ...PG_CONFIG, database: DATABASE });
    listener = new Client({ ...PG_CONFIG, database: DATABASE });
    await postgres.connect();
    await listener.connect();
    const limited = new Client({
      ...PG_CONFIG,
      database: DATABASE,
      user: "workbench_ddl_limited",
      password: "limited-password",
    });
    await limited.connect();
    try {
      await limited.query(buildWorkbenchDdlProvisioningSql("limited_workbench"));
    } catch (error) {
      permissionErrorCode = String((error as { code?: unknown }).code ?? "");
    } finally {
      await limited.end();
    }
    permissionSchemaExists =
      (
        await postgres.query(
          "SELECT pg_catalog.to_regnamespace('limited_workbench') IS NOT NULL AS present",
        )
      ).rows[0]?.present === true;
    await admin.query(`REVOKE CREATE ON DATABASE ${DATABASE} FROM workbench_ddl_limited`);
    await admin.query("DROP ROLE workbench_ddl_limited");
    await postgres.query(buildWorkbenchDdlProvisioningSql("workbench"));
    await postgres.query(buildWorkbenchDdlProvisioningSql("workbench"));
    await listener.query(`LISTEN ${WORKBENCH_DDL_CHANNEL}`);
    listener.on("notification", (notification: Notification) => {
      if (notification.channel === WORKBENCH_DDL_CHANNEL && notification.payload) {
        received.push(parsePostgresDdlNotification(notification.payload));
      }
    });
    session = await ensureLocalCodeMonikerWorkspace({
      runtimePath: RUNTIME,
      workspaceRoots: [workspaceRoot],
      clientName: "postgresql-workbench-ddl-sync-e2e",
    });
    await waitForWorkspaceReady();
    const baseline = await readPostgresCatalog(catalogClient(postgres), IDENTITY);
    documents = new Map(baseline.sourceSet.documents.map((document) => [document.uri, document]));
    origins = new Map(baseline.origins);
    await session.client.sources.replace(baseline.sourceSet);
  }, 30_000);

  afterAll(async () => {
    if (postgres) {
      await postgres.query(buildWorkbenchDdlRemovalSql("workbench")).catch(() => undefined);
      await postgres.end().catch(() => undefined);
    }
    if (listener) await listener.end().catch(() => undefined);
    if (session) {
      await session.client.sources
        .remove(buildPostgresSourceSet(IDENTITY, [], new Map()).srcset)
        .catch(() => undefined);
      await session.dispose().catch(() => undefined);
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("rolls provisioning back cleanly when the connection is not a superuser", () => {
    expect(permissionErrorCode).toBe("42501");
    expect(permissionSchemaExists).toBe(false);
  });

  it("still reports application DDL when the configured support schema is public", async () => {
    await postgres.query(buildWorkbenchDdlRemovalSql("workbench"));
    await postgres.query(buildWorkbenchDdlProvisioningSql("public"));
    await executeAndCollect("CREATE TABLE public.public_schema_probe (id bigint)");
    const groups = coalescePostgresDdlNotifications(received.splice(0));
    expect(groups).toHaveLength(1);
    expect(
      groups[0]?.objects.some(
        (object) =>
          object.objectType === "table" && object.objectIdentity.includes("public_schema_probe"),
      ),
    ).toBe(true);
    await executeAndCollect(`
      CREATE FUNCTION public.notify_sql_drop(value text) RETURNS text
        LANGUAGE sql IMMUTABLE
        AS 'SELECT value';
    `);
    received.length = 0;
    await executeAndCollect("DROP FUNCTION public.notify_sql_drop(text)");
    const droppedOverload = coalescePostgresDdlNotifications(received.splice(0));
    expect(droppedOverload).toHaveLength(1);
    expect(
      droppedOverload[0]?.objects.some(
        (object) =>
          object.objectType === "function" &&
          object.objectIdentity === "public.notify_sql_drop(pg_catalog.text)",
      ),
    ).toBe(true);
    await postgres.query("DROP TABLE public.public_schema_probe");
    received.length = 0;
    await postgres.query(buildWorkbenchDdlRemovalSql("public"));
    await postgres.query(buildWorkbenchDdlProvisioningSql("workbench"));
  });

  it("updates CREATE, ALTER and DROP events without a full catalog query", async () => {
    await executeAndCollect(`
      CREATE SCHEMA app;
      CREATE TABLE app.account (id bigint PRIMARY KEY);
    `);
    const created = coalescePostgresDdlNotifications(received.splice(0));
    expect(created).toHaveLength(1);
    const createdResult = await applyNotificationsFromCodeMoniker(created);
    expect(createdResult.queries).toHaveLength(1);
    expect(createdResult.queries[0]).toContain("catalog-incremental");
    expect(createdResult.queries[0]).not.toContain("/* workbench:catalog */");
    await expectSymbol("account", "table", true);

    await executeAndCollect(
      "ALTER TABLE app.account ADD CONSTRAINT account_id_positive CHECK (id > 0)",
    );
    const addedConstraint = await applyNotificationsFromCodeMoniker();
    expect(addedConstraint.queries).toHaveLength(1);
    expect(addedConstraint.queries[0]).toContain("catalog-incremental");
    expect(findDocument("table", "account").content).toContain("account_id_positive");

    await executeAndCollect("ALTER TABLE app.account DROP CONSTRAINT account_id_positive");
    const droppedConstraint = await applyNotificationsFromCodeMoniker();
    expect(droppedConstraint.queries).toHaveLength(1);
    expect(droppedConstraint.queries[0]).toContain("catalog-incremental");
    expect(findDocument("table", "account").content).not.toContain("account_id_positive");

    await executeAndCollect("ALTER TABLE app.account ADD COLUMN email text");
    const added = await applyNotificationsFromCodeMoniker();
    expect(added.queries).toHaveLength(1);
    expect(added.queries[0]).toContain("catalog-incremental");
    await expectSymbol("email", "column", true);

    await executeAndCollect("ALTER TABLE app.account DROP COLUMN email");
    const droppedColumn = await applyNotificationsFromCodeMoniker();
    expect(droppedColumn.queries).toHaveLength(1);
    expect(droppedColumn.queries[0]).toContain("catalog-incremental");
    await expectSymbol("email", "column", false);

    await executeAndCollect("DROP TABLE app.account");
    const dropped = await applyNotificationsFromCodeMoniker();
    expect(dropped.queries).toHaveLength(1);
    expect(dropped.queries[0]).toContain("catalog-incremental");
    await expectSymbol("account", "table", false);
  }, 90_000);

  it("reprojects a renamed table and the direct view returned by Code Moniker", async () => {
    await executeAndCollect(`
      CREATE SCHEMA table_rename_case;
      CREATE TABLE table_rename_case.orders (id bigint PRIMARY KEY);
      CREATE VIEW table_rename_case.orders_view AS
        SELECT id FROM table_rename_case.orders;
    `);
    await publishFullCatalog();
    const previousTable = findDocument("table", "orders");
    const dependentView = findDocument("view", "orders_view");

    await executeAndCollect("ALTER TABLE table_rename_case.orders RENAME TO archived_orders");
    const result = await applyNotificationsFromCodeMoniker();

    expect(result.selected).toEqual(new Set([previousTable.uri, dependentView.uri]));
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toContain("workbench:catalog-incremental");
    expect(result.queries[0]).not.toContain("/* workbench:catalog */");
    const renamedTable = findDocument("table", "archived_orders");
    expect(documents.has(previousTable.uri)).toBe(false);
    await expectIncomingFile(renamedTable, dependentView.uri);
  }, 90_000);

  it("reprojects a renamed function and the direct view returned by Code Moniker", async () => {
    await executeAndCollect(`
      CREATE SCHEMA function_rename_case;
      CREATE FUNCTION function_rename_case.total_orders() RETURNS bigint
        LANGUAGE sql
        AS 'SELECT 1::bigint';
      CREATE VIEW function_rename_case.dashboard AS
        SELECT function_rename_case.total_orders() AS total;
    `);
    await publishFullCatalog();
    const previousRoutine = findDocument("routine", "total_orders");
    const dashboard = findDocument("view", "dashboard");

    await executeAndCollect(
      "ALTER FUNCTION function_rename_case.total_orders() RENAME TO total_orders_v2",
    );
    const result = await applyNotificationsFromCodeMoniker();

    expect(result.selected).toEqual(new Set([previousRoutine.uri, dashboard.uri]));
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toContain("workbench:catalog-incremental");
    expect(result.queries[0]).not.toContain("/* workbench:catalog */");
    const renamedRoutine = findDocument("routine", "total_orders_v2");
    expect(documents.has(previousRoutine.uri)).toBe(false);
    await expectIncomingFile(renamedRoutine, dashboard.uri);
  }, 90_000);

  async function executeAndCollect(sql: string): Promise<void> {
    received.length = 0;
    await postgres.query(sql);
    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(received.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async function waitForWorkspaceReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const status = await session.client.workspace.status();
      if (status.phase === "ready") return;
      if (status.phase === "failed") {
        throw new Error(status.failure?.message ?? "Code Moniker workspace indexing failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Code Moniker workspace did not become ready");
  }

  async function publishFullCatalog(): Promise<void> {
    const replacement = await readPostgresCatalog(catalogClient(postgres), IDENTITY);
    documents = new Map(
      replacement.sourceSet.documents.map((document) => [document.uri, document]),
    );
    origins = new Map(replacement.origins);
    await session.client.sources.replace(replacement.sourceSet);
    resources = buildPostgresResourceIndex(documents, await readAllSymbols());
    received.length = 0;
  }

  async function applyNotificationsFromCodeMoniker(
    pendingGroups?: CoalescedPostgresDdlNotification[],
  ): Promise<{
    queries: string[];
    selected: Set<string>;
  }> {
    const groups = pendingGroups ?? coalescePostgresDdlNotifications(received.splice(0));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.fallback).toBe(false);
    const selection = await directPostgresDocumentUris(
      session.client,
      { documents, resources },
      groups[0]!.objects,
    );
    const queries: string[] = [];
    const patch = await readPostgresCatalogDocuments(
      {
        async query(sql) {
          queries.push(sql);
          return catalogClient(postgres).query(sql);
        },
      },
      IDENTITY,
      [...documents.values()],
      selection.documentUris,
      selection.newResources,
    );
    for (const uri of patch.removeDocumentUris) {
      documents.delete(uri);
      origins.delete(uri);
    }
    for (const document of patch.upsertDocuments) documents.set(document.uri, document);
    for (const [uri, origin] of patch.origins) origins.set(uri, origin);
    await session.client.sources.replace(
      buildPostgresSourceSet(IDENTITY, [...documents.values()], origins),
    );
    resources = buildPostgresResourceIndex(documents, await readAllSymbols());
    return { queries, selected: selection.documentUris };
  }

  async function readAllSymbols(): Promise<CodeMonikerSymbol[]> {
    const symbols: CodeMonikerSymbol[] = [];
    let cursor: unknown | null = null;
    do {
      const page = await session.client.symbols.search(
        { language: ["sql"] },
        { consistency: "stale_ok", limit: 500, cursor },
      );
      symbols.push(...page.data.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return symbols;
  }

  function findDocument(
    documentKind: NonNullable<VirtualSqlDocument["postgres"]>["documentKind"],
    name: string,
  ): VirtualSqlDocument {
    const document = [...documents.values()].find(
      (candidate) =>
        candidate.postgres?.documentKind === documentKind && candidate.postgres.name === name,
    );
    expect(document).toBeDefined();
    return document!;
  }

  async function expectIncomingFile(
    document: VirtualSqlDocument,
    dependentUri: string,
  ): Promise<void> {
    const resource = [...resources.values()].find(
      (candidate) => candidate.documentUri === document.uri,
    );
    expect(resource).toBeDefined();
    const files = new Set<string>();
    let cursor: unknown | null = null;
    do {
      const page = await session.client.symbols.usages(
        resource!.symbolUri,
        { direction: "incoming" },
        { consistency: "stale_ok", limit: 500, cursor },
      );
      for (const usage of page.data.rows) files.add(usage.file);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(files).toContain(dependentUri);
  }

  async function expectSymbol(name: string, kind: string, present: boolean): Promise<void> {
    const result = await session.client.symbols.search(
      { text: name, language: ["sql"], kind: [kind] },
      { consistency: "stale_ok" },
    );
    expect(result.data.rows.some((symbol) => symbol.name === name && symbol.kind === kind)).toBe(
      present,
    );
  }
});

function catalogClient(client: Client): CatalogQueryClient {
  return {
    async query(sql) {
      const result = await client.query(sql);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
}
