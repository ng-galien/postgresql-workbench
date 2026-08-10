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
});
