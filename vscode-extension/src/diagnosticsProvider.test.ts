import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  collection: {
    clear: vi.fn(),
    delete: vi.fn(),
    dispose: vi.fn(),
    set: vi.fn(),
  },
  onDidOpen: undefined as ((document: unknown) => void) | undefined,
  onDidSave: undefined as ((document: unknown) => void) | undefined,
}));

vi.mock("vscode", () => ({
  Diagnostic: class {
    source?: string;
    code?: string;
    constructor(
      readonly range: unknown,
      readonly message: string,
      readonly severity: number,
    ) {}
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  Range: class {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  },
  languages: {
    createDiagnosticCollection: () => vscodeState.collection,
  },
  workspace: {
    onDidOpenTextDocument(listener: (document: unknown) => void) {
      vscodeState.onDidOpen = listener;
      return { dispose() {} };
    },
    onDidSaveTextDocument(listener: (document: unknown) => void) {
      vscodeState.onDidSave = listener;
      return { dispose() {} };
    },
  },
}));

vi.mock("../../src/analysis/plpgsqlDocument.js", () => ({
  plpgsqlRoutineBodyStartLine: vi.fn(async () => 2),
}));

import { PlpgsqlDiagnosticsProvider } from "./diagnosticsProvider.js";

const documentUri = { scheme: "code+moniker", toString: () => "code+moniker://routine" };
const document = {
  uri: documentUri,
  getText: () => "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\nEND;\n$$;",
};

describe("plpgsql_check diagnostics", () => {
  const query = vi.fn();
  const connections = {
    activeServer: { id: "demo" },
    getClient: () => ({ query }),
    onServerChanged: () => ({ dispose() {} }),
  };
  const index = {
    sourceDescriptorForDocumentUri: () => ({
      plpgsql: true,
      serverId: "demo",
      oid: 42,
    }),
  };

  beforeEach(() => {
    vscodeState.collection.clear.mockReset();
    vscodeState.collection.delete.mockReset();
    vscodeState.collection.set.mockReset();
    query
      .mockReset()
      .mockImplementation(async (sql: string) =>
        sql.includes("pg_extension")
          ? { rowCount: 1, rows: [{}] }
          : { rowCount: 1, rows: [{ lineno: 1, level: "warning", message: "unused variable" }] },
      );
  });

  it("checks the deployed routine when the buffer matches the deployed source", async () => {
    const provider = new PlpgsqlDiagnosticsProvider(
      connections as never,
      vi.fn() as never,
      index as never,
      { workingCopyDiffersFromDeployed: () => false },
    );
    vscodeState.onDidSave?.(document);

    await vi.waitFor(() => expect(vscodeState.collection.set).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledWith("SELECT * FROM plpgsql_check_function($1::oid)", [42]);
    expect(vscodeState.collection.set).toHaveBeenCalledWith(documentUri, [
      expect.objectContaining({
        message: "unused variable",
        severity: 1,
        source: "plpgsql_check",
        range: expect.objectContaining({ startLine: 2 }),
      }),
    ]);
    provider.dispose();
  });

  it("skips the check and clears diagnostics when the working copy diverges from the deployed routine", async () => {
    const provider = new PlpgsqlDiagnosticsProvider(
      connections as never,
      vi.fn() as never,
      index as never,
      { workingCopyDiffersFromDeployed: () => true },
    );
    vscodeState.onDidSave?.(document);

    await vi.waitFor(() => expect(vscodeState.collection.delete).toHaveBeenCalledWith(documentUri));
    expect(query).not.toHaveBeenCalled();
    expect(vscodeState.collection.set).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("keeps checking when no divergence source is provided", async () => {
    const provider = new PlpgsqlDiagnosticsProvider(
      connections as never,
      vi.fn() as never,
      index as never,
    );
    vscodeState.onDidOpen?.(document);

    await vi.waitFor(() => expect(vscodeState.collection.set).toHaveBeenCalledTimes(1));
    provider.dispose();
  });
});
