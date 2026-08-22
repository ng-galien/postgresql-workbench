import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../../../packages/catalog/src/localCodeMoniker.js";
import type { ServerConfig } from "../../../packages/catalog/src/savedConnection.js";
import { createCodeMonikerSyntaxParser } from "../../../packages/sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type { SqlAuthoringSnapshot } from "../../../packages/sql/src/snapshot.js";

const vscodeMock = vi.hoisted(() => ({ notebookDocuments: [] as unknown[] }));

vi.mock("vscode", () => ({
  Range: class {
    constructor(
      readonly start: number,
      readonly end: number,
    ) {}
  },
  SemanticTokensLegend: class {
    constructor(
      readonly tokenTypes: string[],
      readonly tokenModifiers: string[],
    ) {}
  },
  Uri: {
    parse(uri: string) {
      return { scheme: uri.slice(0, uri.indexOf(":")) };
    },
  },
  workspace: {
    get notebookDocuments() {
      return vscodeMock.notebookDocuments;
    },
  },
}));

vi.mock("vscode-languageclient/node", () => ({
  LanguageClient: class {},
  TransportKind: { ipc: "ipc" },
}));

import { resolveDocumentContext, sqlReferences } from "./client.js";

const server: ServerConfig = {
  id: "demo-server",
  name: "demo",
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  database: "demo",
};

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  serverId: server.id,
  database: server.database,
  revision: "r1",
  generation: 1,
  objects: [],
  foreignKeys: [],
};

const connections = { servers: [server] };
const index = { sqlAuthoringSnapshot: () => snapshot };

describe("SQL authoring document context", () => {
  beforeEach(() => {
    vscodeMock.notebookDocuments = [];
  });

  it("does not treat a cell from another notebook type as a Scratchpad", () => {
    const uri = "vscode-notebook-cell:/foreign/notebook#cell-1";
    vscodeMock.notebookDocuments = [
      {
        notebookType: "foreign-notebook",
        metadata: { serverId: server.id, database: server.database },
        getCells: () => [{ document: { uri: { toString: () => uri } } }],
      },
    ];

    expect(resolveDocumentContext(uri, connections, index)).toMatchObject({
      status: "unavailable",
    });
  });

  it("does not infer a Connexion for an unattached notebook cell", () => {
    expect(
      resolveDocumentContext(
        "vscode-notebook-cell:/scratchpad/reloading#cell-1",
        connections,
        index,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("uses the SQL Document Association", () => {
    const associated = { ...server, id: "reporting-server", database: "reporting" };
    const lookup = vi.fn(() => ({
      ...snapshot,
      serverId: associated.id,
      database: associated.database,
    }));
    expect(
      resolveDocumentContext(
        "file:///workspace/report.sql",
        { ...connections, servers: [server, associated] },
        { sqlAuthoringSnapshot: lookup },
        () => associated.id,
      ),
    ).toMatchObject({
      status: "available",
      snapshot: { serverId: associated.id, database: associated.database },
    });
    expect(lookup).toHaveBeenCalledWith({
      serverId: associated.id,
      database: associated.database,
    });
  });

  it("does not fall back when a free SQL document has no Association", () => {
    expect(
      resolveDocumentContext("file:///workspace/report.sql", connections, index, () => undefined),
    ).toMatchObject({ status: "unassociated" });
  });
});

describe("SQL authoring navigation references", async () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sql-references-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-sql-references",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
    dispose = async () => {
      await session.dispose();
      await rm(workspace, { force: true, recursive: true });
    };
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  it("resolves aliases per Statement and ignores routine homonyms", async () => {
    const source = [
      "SELECT p.id FROM shop.product AS p;",
      "SELECT p.product_id FROM shop.order_line AS p;",
    ].join("\n");
    const document = {
      uri: { toString: () => "file:///query.sql" },
      getText: () => source,
      positionAt: (offset: number) => offset,
    };
    const navigationSnapshot: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [
        {
          serverId: server.id,
          database: server.database,
          schema: "shop",
          oid: 99,
          name: "order_line",
          kind: "function",
          signature: "shop.order_line()",
          parameters: [],
          columns: [],
        },
        {
          serverId: server.id,
          database: server.database,
          schema: "shop",
          oid: 1,
          name: "product",
          kind: "table",
          signature: "shop.product",
          parameters: [],
          columns: [{ name: "id", type: "bigint" }],
        },
        {
          serverId: server.id,
          database: server.database,
          schema: "shop",
          oid: 2,
          name: "order_line",
          kind: "table",
          signature: "shop.order_line",
          parameters: [],
          columns: [{ name: "product_id", type: "bigint" }],
        },
      ],
    };

    const references = await sqlReferences(
      document as unknown as import("vscode").TextDocument,
      navigationSnapshot,
      parser,
    );
    expect(references.find(({ label }) => label === "shop.product.id")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.order_line.product_id")?.target.oid).toBe(
      2,
    );
  });

  it("resolves relations and routines inside an anonymous PL/pgSQL DO block", async () => {
    const source = [
      "DO $workbench$",
      "DECLARE",
      "  v_product_id bigint := (SELECT id FROM shop.product);",
      "BEGIN",
      "  CALL shop.move_inventory(v_product_id);",
      "END",
      "$workbench$;",
    ].join("\n");
    const document = {
      uri: { toString: () => "file:///query.sql" },
      getText: () => source,
      positionAt: (offset: number) => offset,
    };
    const navigationSnapshot: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [
        {
          serverId: server.id,
          database: server.database,
          schema: "shop",
          oid: 1,
          name: "product",
          kind: "table",
          signature: "shop.product",
          parameters: [],
          columns: [{ name: "id", type: "bigint" }],
        },
        {
          serverId: server.id,
          database: server.database,
          schema: "shop",
          oid: 2,
          name: "move_inventory",
          kind: "procedure",
          signature: "move_inventory(bigint)",
          parameters: [{ name: "product_id", type: "bigint" }],
          columns: [],
        },
      ],
    };

    const references = await sqlReferences(
      document as unknown as import("vscode").TextDocument,
      navigationSnapshot,
      parser,
    );
    expect(references.find(({ label }) => label === "shop.product")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.product.id")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.move_inventory")?.target.oid).toBe(2);
  });
});
