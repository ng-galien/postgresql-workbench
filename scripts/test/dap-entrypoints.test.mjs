import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

test("the extension and standalone executable use distinct entries over the shared DAP host", async () => {
  const [build, extensionEntry, standaloneEntry] = await Promise.all([
    readFile(new URL("../../vscode-extension/esbuild.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../vscode-extension/src/dapServer.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/dap/src/main.ts", import.meta.url), "utf8"),
  ]);

  assert.match(build, /entryPoints: \["src\/dapServer\.ts"\]/);
  assert.doesNotMatch(build, /entryPoints: \["\.\.\/packages\/dap\/src\/main\.ts"\]/);
  assert.match(extensionEntry, /from "\.\.\/\.\.\/packages\/dap\/src\/stdioDapServer\.js"/);
  assert.match(standaloneEntry, /from "\.\/stdioDapServer\.js"/);
  assert.deepEqual(relativeImports(extensionEntry), ["../../packages/dap/src/stdioDapServer.js"]);
  assert.deepEqual(relativeImports(standaloneEntry), ["./stdioDapServer.js"]);
});

function relativeImports(source) {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
}
