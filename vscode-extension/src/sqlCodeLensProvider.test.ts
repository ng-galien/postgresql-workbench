import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Uri {
    constructor(
      readonly scheme: string,
      private readonly value: string,
    ) {}
    toString() {
      return this.value;
    }
  }
  return {
    Uri,
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startColumn: number,
        readonly endLine: number,
        readonly endColumn: number,
      ) {}
    },
    CodeLens: class {
      constructor(
        readonly range: unknown,
        readonly command: { title: string },
      ) {}
    },
    EventEmitter: class {
      readonly event = () => ({ dispose() {} });
      fire() {}
    },
  };
});

import * as vscode from "vscode";
import { SqlCodeLensProvider } from "./sqlCodeLensProvider.js";

describe("SQL CodeLens provider", () => {
  it("returns Run immediately even when the semantic parser is unavailable", () => {
    const provider = new SqlCodeLensProvider(async () => {
      throw new Error("runtime unavailable");
    }, connections(false));
    const lenses = provider.provideCodeLenses(document("file", "file:///query.sql", "SELECT +;"));

    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      "$(play) Run SQL",
      "$(database) demo",
    ]);
  });

  it("offers Document Association before an empty SQL document has a Statement", () => {
    const provider = new SqlCodeLensProvider(
      async () => {
        throw new Error("runtime unavailable");
      },
      { ...connections(false), forDocument: () => undefined },
    );

    const lenses = provider.provideCodeLenses(document("file", "file:///query.sql", ""));

    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      "$(database) Choose PostgreSQL connection",
    ]);
  });

  it("keeps Deploy visible for a bound managed routine with invalid working-copy SQL", () => {
    const provider = new SqlCodeLensProvider(async () => {
      throw new Error("invalid working copy");
    }, connections(true));
    const lenses = provider.provideCodeLenses(
      document("code+moniker", "code+moniker://routine", "CREATE OR REPLACE FUNCTION"),
    );

    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      "$(cloud-upload) Deploy managed routine",
    ]);
  });

  it("coalesces rapid document versions and retains only the latest analysis", async () => {
    let releaseFirstParse = () => {};
    const parse = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstParse = () => resolve(emptySyntaxTree());
          }),
      )
      .mockResolvedValue(emptySyntaxTree());
    const provider = new SqlCodeLensProvider(async () => ({ parse }), connections(false));

    provider.provideCodeLenses(document("file", "file:///query.sql", "SELECT 1;", 1));
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    provider.provideCodeLenses(document("file", "file:///query.sql", "SELECT 2;", 2));
    provider.provideCodeLenses(document("file", "file:///query.sql", "SELECT 3;", 3));
    releaseFirstParse();

    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
    expect(parse.mock.calls.map(([request]) => request.source)).toEqual(["SELECT 1;", "SELECT 3;"]);
    const internals = provider as unknown as {
      analysis: Map<string, { version: number }>;
    };
    expect(internals.analysis.size).toBe(1);
    expect(internals.analysis.get("file:///query.sql")?.version).toBe(3);
  });

  it("retries semantic analysis after a transient runtime failure", async () => {
    const syntaxParser = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValue({ parse: vi.fn().mockResolvedValue(emptySyntaxTree()) });
    const provider = new SqlCodeLensProvider(syntaxParser, connections(false));
    const query = document("file", "file:///retry.sql", "SELECT 1;", 1);

    provider.provideCodeLenses(query);
    await vi.waitFor(() => expect(syntaxParser).toHaveBeenCalledTimes(1));
    const internals = provider as unknown as { analysisRunning: Set<string> };
    await vi.waitFor(() => expect(internals.analysisRunning.size).toBe(0));
    provider.provideCodeLenses(query);

    await vi.waitFor(() => expect(syntaxParser).toHaveBeenCalledTimes(2));
  });
});

function connections(canDeploy: boolean) {
  return {
    forDocument: () => ({ id: "demo", name: "demo" }),
    canDebugCall: () => false,
    canDebugDefinition: () => false,
    canDeployManagedRoutine: () => canDeploy,
  };
}

function document(scheme: string, uri: string, text: string, version = 1): vscode.TextDocument {
  const TestUri = vscode.Uri as unknown as new (scheme: string, value: string) => vscode.Uri;
  return {
    uri: new TestUri(scheme, uri),
    version,
    getText: () => text,
  } as never;
}

function emptySyntaxTree() {
  return {
    file: "statements.sql",
    language: "sql",
    focus: "",
    focusLineRange: null,
    root: {
      kind: "source_file",
      language: "sql",
      named: true,
      error: false,
      missing: false,
      byteRange: [0, 0],
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
      text: null,
      children: [],
    },
    emittedNodes: 1,
    totalNodes: 1,
    maxDepth: 1,
    truncated: false,
    hasError: false,
  };
}
