import { describe, expect, it } from "vitest";
import {
  type CatalogQueryClient,
  mergePostgresCatalogRelations,
  PostgresCatalogFullRefreshRequired,
  postgresDatabaseDocumentGlob,
  postgresDocumentUri,
  postgresSourceSetName,
  readPostgresCatalog,
  readPostgresCatalogDocuments,
} from "./postgresCatalog.js";

class FakeCatalogClient implements CatalogQueryClient {
  readonly calls: string[] = [];

  constructor(
    private readonly failOn?: string,
    private readonly extensionName = "pgtap",
    private readonly routineOid = 40,
  ) {}

  async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push(sql);
    if (this.failOn && sql.includes(this.failOn)) {
      throw new Error("catalog failed");
    }
    return {
      rows: [
        {
          schemas: [{ oid: 10, schema_name: "app" }],
          tables: [
            {
              table_oid: 20,
              schema_name: "app",
              table_name: "account",
            },
            {
              table_oid: 23,
              schema_name: "app",
              table_name: "audit_marker",
            },
          ],
          columns: [
            {
              table_oid: 20,
              schema_name: "app",
              table_name: "account",
              column_number: 1,
              column_name: "id",
              data_type: "bigint",
              not_null: true,
              default_expr: null,
              identity_kind: "",
              generated_kind: "",
            },
            {
              table_oid: 20,
              schema_name: "app",
              table_name: "account",
              column_number: 2,
              column_name: "owner_id",
              data_type: "bigint",
              not_null: false,
              default_expr: null,
              identity_kind: "",
              generated_kind: "",
            },
          ],
          constraints: [
            {
              table_oid: 20,
              constraint_oid: 21,
              constraint_name: "account_pkey",
              definition: "PRIMARY KEY (id)",
              validated: true,
            },
            {
              table_oid: 20,
              constraint_oid: 22,
              constraint_name: "account_owner_fkey",
              definition: "FOREIGN KEY (owner_id) REFERENCES app.owner(id)",
              referenced_table_oid: "24",
              source_columns: ["owner_id"],
              source_columns_nullable: [true],
              referenced_columns: ["id"],
              validated: true,
            },
          ],
          views: [
            {
              oid: 30,
              schema_name: "app",
              object_name: "active_account",
              definition: " SELECT account.id\n FROM app.account;",
            },
          ],
          view_dependencies: [
            {
              source_view_oid: 30,
              target_relation_oid: 20,
            },
          ],
          routines: [
            {
              oid: 41,
              schema_name: "public",
              object_name: "extension_probe",
              identity_arguments: "",
              extension_name: this.extensionName,
              definition:
                "CREATE OR REPLACE FUNCTION public.extension_probe() RETURNS boolean " +
                "LANGUAGE sql AS $function$ SELECT true $function$",
            },
            {
              oid: this.routineOid,
              schema_name: "app",
              object_name: "find_account",
              identity_arguments: "p_id bigint",
              definition:
                "CREATE OR REPLACE FUNCTION app.find_account(p_id bigint)\n" +
                "RETURNS bigint\nLANGUAGE sql\nAS $function$ SELECT id FROM app.account WHERE id = p_id $function$",
            },
          ],
          triggers: [
            {
              oid: 50,
              schema_name: "app",
              object_name: "account_audit",
              relation_name: "account",
              definition:
                "CREATE TRIGGER account_audit AFTER INSERT ON app.account " +
                "FOR EACH ROW EXECUTE FUNCTION app.audit_account()",
            },
          ],
        },
      ],
    };
  }
}

describe("readPostgresCatalog", () => {
  it("builds one stable relational source set from a coherent catalog snapshot", async () => {
    const client = new FakeCatalogClient();

    const first = await readPostgresCatalog(client, {
      connectionId: "local-dev",
      database: "sample",
    });
    const second = await readPostgresCatalog(new FakeCatalogClient(), {
      connectionId: "local-dev",
      database: "sample",
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toContain("workbench:catalog");
    expect(client.calls[0]).toContain("workbench:tables");
    expect(client.calls[0]).toContain("constraint_row.convalidated AS validated");
    expect(first.sourceSet.srcset).toMatch(/^postgres-[a-f0-9]{20}$/);
    expect(first.sourceSet.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sourceSet.revision).toBe(second.sourceSet.revision);
    expect(first.sourceSet.documents[0]?.uri).toMatch(/^postgresql:\/\/local-dev\/sample\//);
    expect(first.sourceSet.documents).toHaveLength(7);
    expect(first.metrics.documentCount).toBe(7);

    const table = first.sourceSet.documents.find((document) => document.postgres?.oid === 20);
    expect(table?.uri).toMatch(/\/table\/account\.sql$/);
    expect(table?.content).toContain('CREATE TABLE "app"."account"');
    expect(table?.content).toContain('"id" bigint NOT NULL');
    expect(table?.content).toContain(
      'CONSTRAINT "account_owner_fkey" FOREIGN KEY (owner_id) REFERENCES app.owner(id)',
    );
    const emptyTable = first.sourceSet.documents.find((document) => document.postgres?.oid === 23);
    expect(emptyTable?.uri).toMatch(/\/table\/audit_marker\.sql$/);
    expect(emptyTable?.content).toContain('CREATE TABLE "app"."audit_marker"');

    const view = first.sourceSet.documents.find((document) => document.postgres?.oid === 30);
    expect(view?.uri).toMatch(/\/view\/active_account\.sql$/);
    expect(view?.content).toContain('CREATE VIEW "app"."active_account" AS');
    expect(view?.content).toContain("FROM app.account");
    expect(first.viewDependencies).toEqual([{ sourceViewOid: 30, targetRelationOid: 20 }]);
    expect(first.foreignKeys).toEqual([
      {
        sourceTableOid: 20,
        targetTableOid: 24,
        sourceColumns: ["owner_id"],
        sourceColumnsNullable: [true],
        targetColumns: ["id"],
        validated: true,
      },
    ]);

    const routine = first.sourceSet.documents.find((document) => document.postgres?.oid === 40);
    expect(routine?.uri).toMatch(/\/routine\/find_account\(p_id%20bigint\)\.sql$/);
    expect(routine?.content).toMatch(/\$function\$;\n$/);
    const extensionRoutine = first.sourceSet.documents.find(
      (document) => document.postgres?.oid === 41,
    );
    expect(extensionRoutine?.uri).toMatch(/\/routine\/extension_probe\(\)\.sql$/);
    expect(extensionRoutine).toBeDefined();
    expect(first.origins.get(extensionRoutine!.uri)).toEqual({
      kind: "extension",
      extension: "pgtap",
    });

    const trigger = first.sourceSet.documents.find((document) => document.postgres?.oid === 50);
    expect(trigger?.uri).toMatch(/\/trigger\/account\.account_audit\.sql$/);
    expect(trigger?.content).toMatch(/app\.audit_account\(\);\n$/);
  });

  it("surfaces a catalog snapshot failure without issuing object-level queries", async () => {
    const client = new FakeCatalogClient("workbench:tables");

    await expect(
      readPostgresCatalog(client, {
        connectionId: "local-dev",
        database: "sample",
      }),
    ).rejects.toThrow("catalog failed");

    expect(client.calls).toHaveLength(1);
  });

  it("changes the snapshot revision when extension ownership changes without a DDL change", async () => {
    const first = await readPostgresCatalog(new FakeCatalogClient(undefined, "pgtap"), {
      connectionId: "local-dev",
      database: "sample",
    });
    const second = await readPostgresCatalog(new FakeCatalogClient(undefined, "workbench_tools"), {
      connectionId: "local-dev",
      database: "sample",
    });

    expect(second.sourceSet.documents).toEqual(first.sourceSet.documents);
    expect(second.sourceSet.revision).not.toBe(first.sourceSet.revision);
  });

  it("keeps semantic source identity stable when PostgreSQL recreates a routine with a new OID", async () => {
    const first = await readPostgresCatalog(new FakeCatalogClient(undefined, "pgtap", 40), {
      connectionId: "local-dev",
      database: "sample",
    });
    const second = await readPostgresCatalog(new FakeCatalogClient(undefined, "pgtap", 400), {
      connectionId: "local-dev",
      database: "sample",
    });
    const firstRoutine = first.sourceSet.documents.find(
      (document) => document.postgres?.oid === 40,
    );
    const secondRoutine = second.sourceSet.documents.find(
      (document) => document.postgres?.oid === 400,
    );

    expect(secondRoutine?.uri).toBe(firstRoutine?.uri);
    expect(second.sourceSet.revision).toBe(first.sourceSet.revision);
    expect(secondRoutine?.postgres?.oid).toBe(400);
  });

  it("namespaces identical deployment OIDs by connection without putting the OID in identity", async () => {
    const first = await readPostgresCatalog(new FakeCatalogClient(), {
      connectionId: "first:5432/sample:postgres",
      database: "sample",
    });
    const second = await readPostgresCatalog(new FakeCatalogClient(), {
      connectionId: "second:5432/sample:postgres",
      database: "sample",
    });
    const firstRoutine = first.sourceSet.documents.find(
      (document) => document.postgres?.oid === 40,
    );
    const secondRoutine = second.sourceSet.documents.find(
      (document) => document.postgres?.oid === 40,
    );

    expect(firstRoutine?.uri).not.toBe(secondRoutine?.uri);
    expect(firstRoutine?.uri).not.toContain("/40.sql");
    expect(secondRoutine?.uri).not.toContain("/40.sql");
    expect(first.sourceSet.srcset).not.toBe(second.sourceSet.srcset);
    expect(
      first.sourceSet.documents.every((document) =>
        document.uri.startsWith(
          postgresDatabaseDocumentGlob({
            connectionId: "first:5432/sample:postgres",
            database: "sample",
          }).slice(0, -2),
        ),
      ),
    ).toBe(true);
    expect(
      second.sourceSet.documents.every((document) =>
        document.uri.startsWith(
          postgresDatabaseDocumentGlob({
            connectionId: "second:5432/sample:postgres",
            database: "sample",
          }).slice(0, -2),
        ),
      ),
    ).toBe(true);
  });

  it("derives every PostgreSQL index identity from the exact Connection and database", () => {
    const first = {
      connectionId: "db.example.test:5432/app:alice",
      database: "app",
    };
    const second = {
      connectionId: "db.example.test:5432/app:bob",
      database: "app",
    };

    const firstUri = postgresDocumentUri(first, "public", "table", "shared_name");
    const secondUri = postgresDocumentUri(second, "public", "table", "shared_name");

    expect(firstUri).not.toBe(secondUri);
    expect(firstUri.startsWith(postgresDatabaseDocumentGlob(first).slice(0, -2))).toBe(true);
    expect(secondUri.startsWith(postgresDatabaseDocumentGlob(second).slice(0, -2))).toBe(true);
    expect(postgresSourceSetName(first)).not.toBe(postgresSourceSetName(second));
  });

  it("reprojects only the exact documents selected by the SourceSet provider", async () => {
    const baseline = await readPostgresCatalog(new FakeCatalogClient(), {
      connectionId: "local-dev",
      database: "sample",
    });
    const account = baseline.sourceSet.documents.find((document) => document.postgres?.oid === 20)!;
    const activeAccount = baseline.sourceSet.documents.find(
      (document) => document.postgres?.oid === 30,
    )!;
    const calls: string[] = [];
    const client: CatalogQueryClient = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes("catalog-incremental")) {
          return {
            rows: [
              {
                schemas: [],
                tables: [{ table_oid: 20, schema_name: "app", table_name: "account" }],
                columns: [
                  {
                    table_oid: 20,
                    schema_name: "app",
                    table_name: "account",
                    column_number: 1,
                    column_name: "id",
                    data_type: "bigint",
                    not_null: true,
                    default_expr: null,
                    identity_kind: "",
                    generated_kind: "",
                  },
                  {
                    table_oid: 20,
                    schema_name: "app",
                    table_name: "account",
                    column_number: 2,
                    column_name: "email",
                    data_type: "text",
                    not_null: false,
                    default_expr: null,
                    identity_kind: "",
                    generated_kind: "",
                  },
                ],
                constraints: [
                  {
                    table_oid: 20,
                    constraint_oid: 70,
                    constraint_name: "account_owner_fkey",
                    definition: "FOREIGN KEY (id) REFERENCES app.owner(id)",
                    referenced_table_oid: "24",
                    source_columns: ["id"],
                    source_columns_nullable: [false],
                    referenced_columns: ["id"],
                    validated: true,
                  },
                  {
                    table_oid: 20,
                    constraint_oid: 71,
                    constraint_name: "account_region_fkey",
                    definition: "FOREIGN KEY (email) REFERENCES app.region(code)",
                    referenced_table_oid: "25",
                    source_columns: ["email"],
                    source_columns_nullable: [true],
                    referenced_columns: ["code"],
                    validated: true,
                  },
                  {
                    table_oid: 60,
                    constraint_oid: 72,
                    constraint_name: "audit_account_fkey",
                    definition: "FOREIGN KEY (account_id) REFERENCES app.account(id)",
                    referenced_table_oid: "20",
                    source_columns: ["account_id"],
                    source_columns_nullable: [false],
                    referenced_columns: ["id"],
                    validated: true,
                  },
                ],
                views: [
                  {
                    oid: 30,
                    schema_name: "app",
                    object_name: "active_account",
                    definition: " SELECT account.id\n FROM app.account;",
                  },
                ],
                view_dependencies: [
                  {
                    source_view_oid: 30,
                    target_relation_oid: 20,
                  },
                ],
                routines: [],
                triggers: [],
              },
            ],
          };
        }
        throw new Error("complete catalog query must not run");
      },
    };

    const patch = await readPostgresCatalogDocuments(
      client,
      { connectionId: "local-dev", database: "sample" },
      baseline.sourceSet.documents,
      new Set([account.uri, activeAccount.uri]),
    );

    expect(calls).toHaveLength(1);
    expect(calls.every((sql) => sql.includes("catalog-incremental"))).toBe(true);
    expect(calls[0]).toContain("constraint_row.confrelid");
    expect(calls[0]).toContain("target_relation.oid IN");
    expect(patch.upsertDocuments).toHaveLength(2);
    expect(
      patch.upsertDocuments.find((document) => document.postgres?.oid === 20)?.content,
    ).toContain('"email" text');
    expect(patch.removeDocumentUris).toEqual([]);
    expect(patch.upsertDocuments.map((document) => document.postgres?.oid).sort()).toEqual([
      20, 30,
    ]);
    expect(patch.foreignKeys).toEqual([
      {
        sourceTableOid: 20,
        targetTableOid: 24,
        sourceColumns: ["id"],
        sourceColumnsNullable: [false],
        targetColumns: ["id"],
        validated: true,
      },
      {
        sourceTableOid: 20,
        targetTableOid: 25,
        sourceColumns: ["email"],
        sourceColumnsNullable: [true],
        targetColumns: ["code"],
        validated: true,
      },
      {
        sourceTableOid: 60,
        targetTableOid: 20,
        sourceColumns: ["account_id"],
        sourceColumnsNullable: [false],
        targetColumns: ["id"],
        validated: true,
      },
    ]);

    const existingForeignKeys = [patch.foreignKeys[0]!, patch.foreignKeys[2]!];
    const merged = mergePostgresCatalogRelations(
      existingForeignKeys,
      [{ sourceViewOid: 30, targetRelationOid: 24 }],
      patch,
    );
    expect(merged.foreignKeys).toEqual(patch.foreignKeys);
    expect(merged.viewDependencies).toEqual([{ sourceViewOid: 30, targetRelationOid: 20 }]);
    expect(
      mergePostgresCatalogRelations(merged.foreignKeys, merged.viewDependencies, patch),
    ).toEqual(merged);
  });

  it("requests a full replacement when a selected document has no local mapping", async () => {
    await expect(
      readPostgresCatalogDocuments(
        new FakeCatalogClient(),
        { connectionId: "local-dev", database: "sample" },
        [],
        new Set(["postgresql://local-dev/sample/app/table/missing.sql"]),
      ),
    ).rejects.toBeInstanceOf(PostgresCatalogFullRefreshRequired);
  });
});
