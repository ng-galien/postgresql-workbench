import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../serverStore.js";
import type { SqlAuthoringSnapshot } from "./protocol.js";

const vscodeMock = vi.hoisted(() => ({ notebookDocuments: [] as unknown[] }));

vi.mock("vscode", () => ({
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

import { resolveDocumentContext } from "./client.js";

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
