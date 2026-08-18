import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeMonikerSyntaxParser } from "../src/analysis/codeMonikerSyntax.js";
import {
  connectLocalCodeMoniker,
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../src/workbench/localCodeMoniker.js";

const runtimePath = resolve(
  process.env.CODE_MONIKER_RUNTIME ?? "vscode-extension/runtime/code-moniker",
);
const executable = process.platform === "win32" ? "code-moniker.exe" : "code-moniker";
const localArtifactsAvailable =
  existsSync(join(runtimePath, "manifest.json")) &&
  existsSync(join(runtimePath, "client", "node.cjs")) &&
  existsSync(join(runtimePath, "bin", executable));

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
    if (isolatedWorkspace) rmSync(isolatedWorkspace, { recursive: true, force: true });
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
