import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./mark-test-output-esm.mjs", import.meta.url));

test("marks only the compiled test trees as ES modules", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "postgresql-workbench-esm-"));
  try {
    await execute(process.execPath, [script, output]);
    for (const directory of ["packages", "vscode-extension"]) {
      const manifest = JSON.parse(
        await readFile(path.join(output, directory, "package.json"), "utf8"),
      );
      assert.deepEqual(manifest, { private: true, type: "module" });
    }
    await assert.rejects(readFile(path.join(output, "package.json"), "utf8"));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
