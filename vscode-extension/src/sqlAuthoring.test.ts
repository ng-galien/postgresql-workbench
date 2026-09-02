import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../../packages/catalog/src/savedConnection.js";
import type { SqlAuthoringSnapshot } from "../../packages/sql/src/snapshot.js";

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

import { resolveDocumentContext } from "./sqlAuthoring.js";

const connection: ConnectionConfig = {
  id: "demo-connection",
  name: "demo",
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  database: "demo",
};

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  connectionId: connection.id,
  database: connection.database,
  revision: "r1",
  generation: 1,
  objects: [],
  foreignKeys: [],
};

const connections = { connections: [connection] };
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
        metadata: { connectionId: connection.id, database: connection.database },
        getCells: () => [{ document: { uri: { toString: () => uri } } }],
      },
    ];

    expect(resolveDocumentContext(uri, connections, index)).toMatchObject({
      status: "unavailable",
    });
  });

  it("does not infer a Connection for an unattached notebook cell", () => {
    expect(
      resolveDocumentContext(
        "vscode-notebook-cell:/scratchpad/reloading#cell-1",
        connections,
        index,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("uses the SQL Document Association", () => {
    const associated = { ...connection, id: "reporting-connection", database: "reporting" };
    const lookup = vi.fn(() => ({
      ...snapshot,
      connectionId: associated.id,
      database: associated.database,
    }));
    expect(
      resolveDocumentContext(
        "file:///workspace/report.sql",
        { ...connections, connections: [connection, associated] },
        { sqlAuthoringSnapshot: lookup },
        () => associated.id,
      ),
    ).toMatchObject({
      status: "available",
      snapshot: { connectionId: associated.id, database: associated.database },
    });
    expect(lookup).toHaveBeenCalledWith({
      connectionId: associated.id,
      database: associated.database,
    });
  });

  it("does not fall back when a free SQL document has no Association", () => {
    expect(
      resolveDocumentContext("file:///workspace/report.sql", connections, index, () => undefined),
    ).toMatchObject({ status: "unassociated" });
  });
});
