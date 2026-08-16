import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../serverStore.js";
import type { SqlAuthoringSnapshot } from "./protocol.js";

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

const connections = {
  activeServer: server,
  isConnected: true,
  servers: [server],
};
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

  it("does not fall back to the active DatabaseContext for an unattached notebook cell", () => {
    expect(
      resolveDocumentContext(
        "vscode-notebook-cell:/scratchpad/reloading#cell-1",
        connections,
        index,
      ),
    ).toMatchObject({ status: "unavailable" });
  });
});

describe("SQL authoring navigation references", () => {
  it("resolves aliases per Statement and ignores routine homonyms", () => {
    const source = [
      "SELECT p.id FROM shop.product AS p;",
      "SELECT p.product_id FROM shop.order_line AS p;",
    ].join("\n");
    const document = {
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

    const references = sqlReferences(
      document as unknown as import("vscode").TextDocument,
      navigationSnapshot,
    );
    expect(references.find(({ label }) => label === "shop.product.id")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.order_line.product_id")?.target.oid).toBe(
      2,
    );
  });
});
