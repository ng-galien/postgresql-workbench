import * as assert from "node:assert";
import * as vscode from "vscode";
import type { PlpgsqlExtensionApi } from "../../../src/extension.js";

const EXTENSION_ID = "ng-galien.postgresql-workbench";

suite("PostgreSQL Workbench cross-platform activation", function () {
  this.timeout(60_000);

  test("activates VS Code and starts the packaged Code Moniker runtime", async () => {
    const extension = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not installed in the test host`);

    const api = extension.isActive ? extension.exports : await extension.activate();
    assert.ok(extension.isActive, "PostgreSQL Workbench did not activate");

    const parser = await api.workbenchIndex.syntaxParser();
    const syntax = await parser.parse({
      language: "sql",
      source: "SELECT 1;",
      uri: "cross-platform-smoke.sql",
    });
    assert.equal(syntax.file, "cross-platform-smoke.sql");
    assert.equal(syntax.hasError, false);
    assert.ok(syntax.totalNodes > 0, "Code Moniker returned no SQL syntax nodes");
  });
});
