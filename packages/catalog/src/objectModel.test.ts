import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkbenchSchemas,
  buildWorkbenchTableMembers,
  listWorkbenchSchemas,
  searchWorkbenchObjects,
  type WorkbenchTreeSymbol,
} from "./objectModel.js";

const DATABASE = {
  connectionId: "localhost:5433/postgres:postgres",
  database: "postgres",
};

const descriptors = new Map<string, WorkbenchTreeSymbol["postgres"]>();

function databaseFile(
  schema: string,
  kind: string,
  oid: number,
  semanticName = `${kind}_${oid}`,
): string {
  const uri =
    `postgresql://${encodeURIComponent(DATABASE.connectionId)}/${DATABASE.database}/` +
    `${schema}/${kind}/${encodeURIComponent(semanticName)}.sql`;
  descriptors.set(uri, {
    ...DATABASE,
    schema,
    documentKind: kind as NonNullable<WorkbenchTreeSymbol["postgres"]>["documentKind"],
    oid,
    name: semanticName,
    signature: "",
  });
  return uri;
}

function symbol(
  name: string,
  kind: string,
  file: string,
  signature = "",
  sourceLines: string[] = [],
): WorkbenchTreeSymbol {
  return {
    uri: `code+moniker://./lang:sql/${kind}:${name}`,
    name,
    kind,
    file,
    signature,
    source: {
      lines: sourceLines.map((text, index) => ({ number: index + 1, text })),
    },
    postgres: descriptors.get(file),
  };
}

describe("Workbench tree model", () => {
  it("contributes separate database and Scratchpads trees", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "../../../vscode-extension/package.json"), "utf8"),
    ) as {
      contributes: {
        views: Record<string, Array<{ id: string; name: string }>>;
        commands: Array<{ command: string; icon?: string }>;
        configuration: {
          properties: Record<string, { default?: unknown; minimum?: number; maximum?: number }>;
        };
        menus: {
          "view/title": Array<{ command: string; when: string; group: string }>;
          "view/item/context": Array<{ command: string; when: string; group: string }>;
        };
      };
    };
    const explorerViews = manifest.contributes.views["postgresql-workbench"];

    expect(explorerViews).toEqual([
      expect.objectContaining({
        id: "postgresql-workbench-connections",
        name: "Connections",
      }),
      expect.objectContaining({
        id: "postgresql-workbench-scratchpads",
        name: "Scratchpads",
      }),
    ]);

    expect(
      Object.fromEntries(
        manifest.contributes.menus["view/title"]
          .filter((entry) => entry.when === "view == postgresql-workbench-connections")
          .map(({ command, group }) => [command, group]),
      ),
    ).toEqual({
      "postgresql-workbench.pickConnection": "navigation",
      "postgresql-workbench.openDatabaseGraph": "navigation@1",
      "postgresql-workbench.searchDatabaseObjects": "navigation@2",
      "postgresql-workbench.indexDatabase": "navigation@3",
    });
    expect(
      manifest.contributes.commands.find(
        ({ command }) => command === "postgresql-workbench.openDatabaseGraph",
      ),
    ).toMatchObject({ icon: "$(type-hierarchy)" });
    expect(
      manifest.contributes.commands.find(
        ({ command }) => command === "postgresql-workbench.revealDatabaseObjectInTree",
      ),
    ).toMatchObject({ icon: "$(list-tree)" });
    expect(
      manifest.contributes.commands.find(
        ({ command }) => command === "postgresql-workbench.indexDatabase",
      ),
    ).toMatchObject({ icon: "$(refresh)" });
    expect(
      manifest.contributes.commands.find(
        ({ command }) => command === "postgresql-workbench.cancelDatabaseIndex",
      ),
    ).toMatchObject({ icon: "$(debug-stop)" });
    expect(
      manifest.contributes.menus["view/item/context"].find(
        ({ command, when }) =>
          command === "postgresql-workbench.indexDatabase" &&
          when ===
            "view == postgresql-workbench-connections && viewItem == postgresql-workbench-sources",
      ),
    ).toMatchObject({ group: "inline@1" });
    expect(
      manifest.contributes.menus["view/item/context"].find(
        ({ command, when }) =>
          command === "postgresql-workbench.cancelDatabaseIndex" &&
          when ===
            "view == postgresql-workbench-connections && viewItem == postgresql-workbench-sources-indexing",
      ),
    ).toMatchObject({ group: "inline@1" });
    expect(
      manifest.contributes.menus["view/item/context"].filter(({ when }) =>
        when.includes("postgresql-workbench-relation-target"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "postgresql-workbench.revealDatabaseObjectInTree",
          group: "inline@1",
        }),
        expect.objectContaining({
          command: "postgresql-workbench.openDatabaseObject",
          group: "inline@2",
        }),
      ]),
    );
    expect(
      manifest.contributes.configuration.properties[
        "postgresql-workbench.workbench.codeMoniker.commandTimeoutMs"
      ],
    ).toMatchObject({ default: 30_000, minimum: 1_000, maximum: 300_000 });
    expect(
      Object.fromEntries(
        manifest.contributes.menus["view/title"]
          .filter(({ when }) => when === "view == postgresql-workbench-scratchpads")
          .map(({ command, group }) => [command, group]),
      ),
    ).toEqual({
      "postgresql-workbench.newSqlNotebook": "navigation@1",
      "postgresql-workbench.filterSqlNotebooks": "navigation@2",
      "postgresql-workbench.refreshSqlNotebooks": "navigation@3",
    });

    expect(
      Object.fromEntries(
        manifest.contributes.menus["view/item/context"]
          .filter(
            (entry) =>
              typeof entry.command === "string" &&
              [
                "postgresql-workbench.openSqlNotebook",
                "postgresql-workbench.changeSqlNotebookConnection",
                "postgresql-workbench.renameSqlNotebook",
                "postgresql-workbench.duplicateSqlNotebook",
                "postgresql-workbench.exportSqlNotebook",
                "postgresql-workbench.deleteSqlNotebook",
              ].includes(entry.command) &&
              entry.when.includes("postgresql-workbench-scratchpad-auto"),
          )
          .map(({ command, group }) => [command, group]),
      ),
    ).toEqual({
      "postgresql-workbench.openSqlNotebook": "inline@1",
      "postgresql-workbench.changeSqlNotebookConnection": "navigation@1",
      "postgresql-workbench.renameSqlNotebook": "navigation@3",
      "postgresql-workbench.duplicateSqlNotebook": "navigation@4",
      "postgresql-workbench.exportSqlNotebook": "navigation@5",
      "postgresql-workbench.deleteSqlNotebook": "navigation@6",
    });
    expect(
      Object.fromEntries(
        manifest.contributes.commands
          .filter(({ command }) =>
            [
              "postgresql-workbench.newSqlNotebook",
              "postgresql-workbench.openSqlNotebook",
              "postgresql-workbench.renameSqlNotebook",
              "postgresql-workbench.deleteSqlNotebook",
              "postgresql-workbench.refreshSqlNotebooks",
              "postgresql-workbench.filterSqlNotebooks",
            ].includes(command),
          )
          .map(({ command, icon }) => [command, icon]),
      ),
    ).toEqual({
      "postgresql-workbench.newSqlNotebook": "$(notebook-template)",
      "postgresql-workbench.openSqlNotebook": "$(notebook)",
      "postgresql-workbench.renameSqlNotebook": "$(edit)",
      "postgresql-workbench.deleteSqlNotebook": "$(trash)",
      "postgresql-workbench.refreshSqlNotebooks": "$(refresh)",
      "postgresql-workbench.filterSqlNotebooks": "$(search)",
    });
  });

  it("builds database objects only from matching Code Moniker symbols", () => {
    const routineFile = databaseFile(
      "sales",
      "routine",
      42,
      "refresh_orders(account_id:int8,options:numeric(10,2))",
    );
    const symbols: WorkbenchTreeSymbol[] = [
      symbol("sales", "schema", databaseFile("sales", "schema", 10)),
      symbol("orders", "table", databaseFile("sales", "table", 20)),
      symbol("id", "column", databaseFile("sales", "table", 20)),
      symbol("open_orders", "view", databaseFile("sales", "view", 30)),
      symbol(
        "refresh_orders(account_id:int8,options:numeric(10,2))",
        "procedure",
        routineFile,
        "account_id:int8,options:numeric(10,2)",
        [
          "CREATE OR REPLACE PROCEDURE sales.refresh_orders(account_id bigint, options numeric)",
          "LANGUAGE plpgsql",
        ],
      ),
      symbol("shadow_table", "table", routineFile),
      symbol("audit_orders", "trigger", databaseFile("sales", "trigger", 50)),
      symbol("workspace_table", "table", "migrations/001.sql"),
      symbol(
        "other_database",
        "table",
        "postgresql://another-connection/postgres/public/table/60.sql",
      ),
    ];

    const schemas = buildWorkbenchSchemas(symbols, DATABASE);

    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.schema).toBe("sales");
    expect(schemas[0]?.objects.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "table:orders",
      "view:open_orders",
      "procedure:refresh_orders",
      "trigger:audit_orders",
    ]);
    expect(schemas[0]?.objects[2]).toMatchObject({
      oid: 42,
      connectionId: DATABASE.connectionId,
      schema: "sales",
      signature: "account_id:int8,options:numeric(10,2)",
      params: [
        { name: "account_id", type: "int8" },
        { name: "options", type: "numeric(10,2)" },
      ],
      plpgsql: true,
    });
  });

  it("keeps indexed table columns and constraints as ordered SQL members", () => {
    const tableFile = databaseFile("sales", "table", 20);
    const table = buildWorkbenchSchemas([symbol("orders", "table", tableFile)], DATABASE)[0]
      ?.objects[0];
    const symbols: WorkbenchTreeSymbol[] = [
      symbol("orders", "table", tableFile),
      { ...symbol("customer_id", "column", tableFile, "uuid"), line_range: [3, 3] },
      { ...symbol("id", "column", tableFile, "bigint"), line_range: [2, 2] },
      {
        ...symbol("orders_pkey", "constraint", tableFile, "primary key"),
        line_range: [4, 4],
      },
      { ...symbol("102", "constraint", tableFile, "not null"), line_range: [2, 2] },
      symbol("other_id", "column", databaseFile("sales", "table", 21), "integer"),
    ];

    expect(table).toBeDefined();
    expect(buildWorkbenchTableMembers(symbols, table!)).toEqual([
      expect.objectContaining({ kind: "column", name: "id", type: "bigint" }),
      expect.objectContaining({ kind: "column", name: "customer_id", type: "uuid" }),
      expect.objectContaining({
        kind: "constraint",
        name: "orders_pkey",
        type: "primary key",
      }),
    ]);
  });

  it("searches indexed PostgreSQL objects without rebuilding unrelated schemas", () => {
    const overloadedFile = databaseFile("sales", "routine", 43, "refresh_orders(account_id:int8)");
    const symbols = [
      symbol("sales", "schema", databaseFile("sales", "schema", 10)),
      symbol("orders", "table", databaseFile("sales", "table", 20)),
      symbol("refresh_orders(account_id:int8)", "function", overloadedFile, "account_id:int8", [
        "CREATE FUNCTION sales.refresh_orders(account_id bigint)",
        "LANGUAGE plpgsql",
      ]),
      symbol(
        "refresh_orders(account_id:text)",
        "function",
        databaseFile("sales", "routine", 44, "refresh_orders(account_id:text)"),
        "account_id:text",
        ["CREATE FUNCTION sales.refresh_orders(account_id text)", "LANGUAGE plpgsql"],
      ),
      symbol("audit", "schema", databaseFile("audit", "schema", 11)),
      symbol("order_log", "table", databaseFile("audit", "table", 21)),
      symbol("workspace_table", "table", "migrations/001.sql"),
      symbol(
        "foreign_table",
        "table",
        `postgresql://${encodeURIComponent(DATABASE.connectionId)}/another/sales/table/22.sql`,
      ),
    ];

    expect(listWorkbenchSchemas(symbols, DATABASE)).toEqual(["audit", "sales"]);
    expect(
      searchWorkbenchObjects(symbols, DATABASE, "sales refresh int8").map((object) => ({
        schema: object.schema,
        kind: object.kind,
        name: object.name,
        oid: object.oid,
        sourceUri: object.sourceUri,
      })),
    ).toEqual([
      {
        schema: "sales",
        kind: "function",
        name: "refresh_orders",
        oid: 43,
        sourceUri: overloadedFile,
      },
    ]);
    expect(
      searchWorkbenchObjects(symbols, DATABASE, "table order").map((object) => object.name),
    ).toEqual(["order_log", "orders"]);
    expect(searchWorkbenchObjects(symbols, DATABASE, "workspace")).toEqual([]);
    expect(searchWorkbenchObjects(symbols, DATABASE, "foreign")).toEqual([]);
  });
});
