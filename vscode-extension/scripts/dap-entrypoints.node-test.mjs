import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the extension and standalone executable use distinct entries over the shared DAP host", async () => {
  const [build, extensionEntry, standaloneEntry] = await Promise.all([
    readFile(new URL("../esbuild.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/dapServer.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/main.ts", import.meta.url), "utf8"),
  ]);

  assert.match(build, /entryPoints: \["src\/dapServer\.ts"\]/);
  assert.doesNotMatch(build, /entryPoints: \["\.\.\/src\/main\.ts"\]/);
  assert.match(extensionEntry, /from "\.\.\/\.\.\/src\/stdioDapServer\.js"/);
  assert.match(standaloneEntry, /from "\.\/stdioDapServer\.js"/);
  assert.deepEqual(relativeImports(extensionEntry), ["../../src/stdioDapServer.js"]);
  assert.deepEqual(relativeImports(standaloneEntry), ["./stdioDapServer.js"]);
});

function relativeImports(source) {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
}
