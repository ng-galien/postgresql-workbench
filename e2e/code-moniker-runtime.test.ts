import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectLocalCodeMoniker,
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import {
  postgresCaretShape,
  postgresDocumentShape,
} from "../packages/sql/src/analysis/documentShape.js";
import { StatelessCodeMonikerSyntaxRuntime } from "../packages/sql/src/localCodeMonikerSyntax.js";

const runtimePath = resolve(
  process.env.CODE_MONIKER_RUNTIME ?? "vscode-extension/runtime/code-moniker",
);
const executable = process.platform === "win32" ? "code-moniker.exe" : "code-moniker";
const localArtifactsAvailable =
  existsSync(join(runtimePath, "manifest.json")) &&
  existsSync(join(runtimePath, "client", "node.cjs")) &&
  existsSync(join(runtimePath, "bin", executable));

if (process.env.REQUIRE_LOCAL_CODE_MONIKER === "1" && !localArtifactsAvailable) {
  throw new Error(`Packaged Code Moniker runtime is required but unavailable in ${runtimePath}`);
}

const qualifiedSeventeenColumnSelect = `SELECT
  address.id,
  address.label,
  address.line1,
  address.line2,
  address.postal_code,
  address.city,
  address.country_code,
  address.created_at,
  shipment.id,
  shipment.sales_order_id,
  shipment.warehouse_id,
  shipment.shipping_address_id,
  shipment.carrier,
  shipment.tracking_number,
  shipment.status,
  shipment.shipped_at,
  shipment.delivered_at
FROM shop.address AS address
LEFT JOIN shop.shipment AS shipment ON address.id = shipment.shipping_address_id;`;

describe.skipIf(!localArtifactsAvailable)("local Code Moniker runtime contract", () => {
  let isolatedWorkspace: string | undefined;
  let owner: LocalCodeMonikerSession | undefined;
  let client: LocalCodeMonikerSession | undefined;

  afterEach(async () => {
    await client?.dispose();
    await owner?.dispose();
    if (isolatedWorkspace) {
      await rm(isolatedWorkspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("serializes concurrent stateless MCP syntax reads", async () => {
    const runtime = new StatelessCodeMonikerSyntaxRuntime({ runtimePath });
    try {
      const parser = await runtime.parser();
      const [plpgsql, sql] = await Promise.all([
        parser.parse({
          language: "plpgsql",
          source: "BEGIN\n  RETURN 1;\nEND;",
          uri: "debugger.plpgsql",
        }),
        parser.parse({
          language: "sql",
          source:
            "CREATE FUNCTION public.example() RETURNS integer AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;",
          uri: "document.sql",
          maxDepth: 16,
          maxNodes: 512,
          namedOnly: true,
        }),
      ]);

      expect(plpgsql).toMatchObject({ language: "plpgsql", hasError: false });
      expect(sql).toMatchObject({ language: "sql", hasError: false });
    } finally {
      await runtime.dispose();
    }
  });

  it("proves SQL and PL/pgSQL routine-body regions through the real syntax port", async () => {
    const source = `CREATE FUNCTION public.sql_body() RETURNS integer
LANGUAGE sql AS $sql$ SELECT 1; $sql$;

CREATE FUNCTION public.plpgsql_body() RETURNS integer
LANGUAGE plpgsql AS $plpgsql$ BEGIN RETURN 1; END; $plpgsql$;`;
    const runtime = new StatelessCodeMonikerSyntaxRuntime({ runtimePath });
    try {
      const parser = await runtime.parser();
      const syntax = await parser.parse({ language: "sql", source, uri: "routines.sql" });
      const shape = postgresDocumentShape(source, syntax);

      expect(shape.root.children.map(({ language }) => language)).toEqual(["sql", "plpgsql"]);
      expect(shape.root.children.map(({ analysisSource }) => analysisSource)).toEqual([
        "SELECT 1; ",
        "BEGIN RETURN 1; END; ",
      ]);
      for (const region of shape.root.children) {
        expect(source.slice(region.sourceRange.start, region.sourceRange.end)).toBe(
          region.analysisSource,
        );
      }
      expect(postgresCaretShape(shape, source.indexOf("SELECT 1"))?.language).toBe("sql");
      expect(postgresCaretShape(shape, source.indexOf("BEGIN RETURN"))?.language).toBe("plpgsql");
      const sqlClosingDelimiter = source.indexOf("$sql$", source.indexOf("$sql$") + 1);
      expect(postgresCaretShape(shape, sqlClosingDelimiter)).toMatchObject({
        language: "sql",
        status: "projected",
        analysisOffset: "SELECT 1; ".length,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("proves DO and nested SQL regions through the real syntax port", async () => {
    const source = `CREATE FUNCTION public.nested_sql() RETURNS integer
LANGUAGE plpgsql AS $plpgsql$ BEGIN RETURN (SELECT 1); END; $plpgsql$;
DO $body$ BEGIN PERFORM 1; END; $body$;`;
    const runtime = new StatelessCodeMonikerSyntaxRuntime({ runtimePath });
    try {
      const parser = await runtime.parser();
      const syntax = await parser.parse({ language: "sql", source, uri: "block.sql" });
      const shape = postgresDocumentShape(source, syntax);

      expect(shape.root.children).toHaveLength(2);
      expect(shape.root.children.map(({ language }) => language)).toEqual(["plpgsql", "plpgsql"]);
      expect(shape.root.children.map(({ target }) => target)).toEqual([
        { status: "available", target: { language: "plpgsql", entryPoint: "block" } },
        { status: "available", target: { language: "plpgsql", entryPoint: "block" } },
      ]);
      expect(shape.root.children[0].children).toContainEqual(
        expect.objectContaining({
          language: "sql",
          kind: "embedded-sql",
          target: {
            status: "available",
            target: { language: "sql", entryPoint: "expression" },
          },
        }),
      );
      expect(postgresCaretShape(shape, source.indexOf("SELECT 1"))?.language).toBe("sql");
      expect(postgresCaretShape(shape, source.indexOf("PERFORM"))?.language).toBe("plpgsql");
      expect(
        postgresCaretShape(shape, source.indexOf("PERFORM 1") + "PERFORM ".length)?.language,
      ).toBe("sql");
    } finally {
      await runtime.dispose();
    }
  });

  it("projects the unique caret position of an empty SQL routine body", async () => {
    const source =
      "CREATE FUNCTION public.empty_body() RETURNS void LANGUAGE sql AS $empty$$empty$;";
    const runtime = new StatelessCodeMonikerSyntaxRuntime({ runtimePath });
    try {
      const parser = await runtime.parser();
      const syntax = await parser.parse({ language: "sql", source, uri: "empty-routine.sql" });
      const shape = postgresDocumentShape(source, syntax);
      const bodyOffset = source.indexOf("$empty$") + "$empty$".length;

      expect(shape.root.children).toHaveLength(1);
      expect(shape.root.children[0]).toMatchObject({
        language: "sql",
        analysisSource: "",
        sourceRange: { start: bodyOffset, end: bodyOffset },
      });
      expect(postgresCaretShape(shape, bodyOffset)).toMatchObject({
        language: "sql",
        status: "projected",
        analysisOffset: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("does not launch a daemon when a syntax client connects", async () => {
    isolatedWorkspace = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-client-"));

    await expect(
      connectLocalCodeMoniker({
        runtimePath,
        workspaceRoots: [isolatedWorkspace],
        clientName: "postgresql-workbench-contract-test",
      }),
    ).rejects.toThrow("No Code Moniker daemon is running");
  });

  it("keeps the workspace daemon alive when an exact syntax client disconnects", async () => {
    isolatedWorkspace = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-owner-"));
    owner = await ensureLocalCodeMonikerWorkspace({
      runtimePath,
      workspaceRoots: [isolatedWorkspace],
      clientName: "postgresql-workbench-contract-owner",
    });

    client = await connectLocalCodeMoniker({
      runtimePath,
      workspaceRoots: [isolatedWorkspace],
      clientName: "postgresql-workbench-contract-client",
      daemon: owner.daemon,
    });

    const clientParser = createCodeMonikerSyntaxParser(client.client);
    expect((await clientParser.parse({ language: "sql", source: "SELECT 1" })).hasError).toBe(
      false,
    );
    await client.dispose();
    client = undefined;

    const ownerParser = createCodeMonikerSyntaxParser(owner.client);
    expect((await ownerParser.parse({ language: "sql", source: "SELECT 2" })).hasError).toBe(false);
  });

  it("reaches ready before and after publishing PostgreSQL virtual sources", async () => {
    isolatedWorkspace = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-ready-"));
    seedNonEmptyWorkspace(isolatedWorkspace);

    owner = await ensureLocalCodeMonikerWorkspace({
      runtimePath,
      workspaceRoots: [isolatedWorkspace],
      clientName: "postgresql-workbench-readiness-contract-owner",
    });

    await waitForWorkspaceReady(owner, 60_000);
    const symbols = await owner.client.symbols.search(
      { path: ["**/entity-0511.ts"] },
      { consistency: "stale_ok", limit: 100 },
    );
    expect(symbols.data.rows.length).toBeGreaterThan(0);

    const virtualRoot = "postgresql://readiness/workbench/";
    const virtualUri = `${virtualRoot}public/table/workbench_readiness.sql`;
    await owner.client.sources.replace({
      srcset: "postgres-workbench-readiness",
      revision: "virtual-source-set-1",
      documents: [
        {
          uri: virtualUri,
          language: "sql",
          content: "CREATE TABLE public.workbench_readiness (id bigint PRIMARY KEY);\n",
        },
      ],
    });
    await waitForWorkspaceReady(owner, 60_000);

    const virtualSymbols = await owner.client.symbols.search(
      { kind: ["table"], path: [`${virtualRoot}**`] },
      { consistency: "stale_ok", limit: 100 },
    );
    expect(virtualSymbols.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: virtualUri, name: "workbench_readiness" }),
      ]),
    );
  }, 90_000);

  it("honors Workbench-selected SQL syntax budgets without a server clamp", async () => {
    isolatedWorkspace = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-budget-"));
    owner = await ensureLocalCodeMonikerWorkspace({
      runtimePath,
      workspaceRoots: [isolatedWorkspace],
      clientName: "postgresql-workbench-budget-contract-owner",
    });
    const parser = createCodeMonikerSyntaxParser(owner.client);

    const normalBudget = await parser.parse({
      language: "sql",
      source: qualifiedSeventeenColumnSelect,
      maxDepth: 64,
      maxNodes: 2_000,
    });
    expect(normalBudget).toMatchObject({ hasError: false, truncated: false });
    expect(normalBudget.emittedNodes).toBe(normalBudget.totalNodes);

    await expect(
      parser.parse({
        language: "sql",
        source: qualifiedSeventeenColumnSelect,
        maxDepth: 1_000,
        maxNodes: 20_000,
      }),
    ).resolves.toMatchObject({ hasError: false, truncated: false });

    const smallBudget = await parser.parse({
      language: "sql",
      source: qualifiedSeventeenColumnSelect,
      maxDepth: 4,
      maxNodes: 10,
    });
    const repeatedSmallBudget = await parser.parse({
      language: "sql",
      source: qualifiedSeventeenColumnSelect,
      maxDepth: 4,
      maxNodes: 10,
    });
    expect(smallBudget).toMatchObject({ hasError: false, truncated: true });
    expect(smallBudget.emittedNodes).toBeLessThanOrEqual(10);
    expect(repeatedSmallBudget).toMatchObject({
      emittedNodes: smallBudget.emittedNodes,
      totalNodes: smallBudget.totalNodes,
      maxDepth: smallBudget.maxDepth,
      truncated: true,
    });
    await expect(
      parser.parse({
        language: "sql",
        source: qualifiedSeventeenColumnSelect,
        maxDepth: 64,
        maxNodes: 0,
      }),
    ).rejects.toThrow();
  });
});

function seedNonEmptyWorkspace(workspaceRoot: string): void {
  for (let fileIndex = 0; fileIndex < 512; fileIndex += 1) {
    const directory = join(
      workspaceRoot,
      "fixture with spaces",
      "sources été",
      "generated",
      String(Math.floor(fileIndex / 32)).padStart(2, "0"),
    );
    mkdirSync(directory, { recursive: true });
    const functions = Array.from(
      { length: 16 },
      (_, functionIndex) => `
export function entity_${fileIndex}_${functionIndex}(value: number): number {
  return value + ${fileIndex} + ${functionIndex};
}
`,
    ).join("");
    writeFileSync(join(directory, `entity-${String(fileIndex).padStart(4, "0")}.ts`), functions);
  }
}

async function waitForWorkspaceReady(
  session: LocalCodeMonikerSession,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = await session.client.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker workspace preload failed");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Code Moniker workspace remained loading for ${timeoutMs} ms`);
}
