import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodeMonikerRuntime } from "./codeMonikerRuntime.js";

describe("Code Moniker packaged runtime", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("rejects an extension installation without a runtime manifest", () => {
    const runtime = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-runtime-"));
    root = runtime;
    expect(() => inspectCodeMonikerRuntime(runtime)).toThrow("installed extension is missing");
  });

  it("validates the platform, client entries, executable and checksum as one unit", () => {
    root = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-runtime-"));
    mkdirSync(join(root, "client"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "client", "index.cjs"), "module.exports = {};");
    writeFileSync(join(root, "client", "node.cjs"), "module.exports = {};");
    const binary = join(root, "bin", "code-moniker");
    writeFileSync(binary, "test binary");
    chmodSync(binary, 0o755);
    writeFileSync(
      join(root, "manifest.json"),
      `${JSON.stringify({
        format: 2,
        platform: process.platform,
        arch: process.arch,
        target: `${process.platform}-${process.arch}`,
        clientVersion: "0.6.0",
        protocolVersion: 12,
        binaryVersion: "0.6.0",
        source: "local-npm:test",
        clientEntry: "client/index.cjs",
        nodeEntry: "client/node.cjs",
        binary: "bin/code-moniker",
        binarySha256: createHash("sha256").update("test binary").digest("hex"),
      })}\n`,
    );

    expect(inspectCodeMonikerRuntime(root)).toMatchObject({
      rootPath: root,
      binaryPath: binary,
      manifest: { protocolVersion: 12, clientVersion: "0.6.0" },
    });
  });

  it("rejects a platform-specific runtime installed on another architecture", () => {
    const runtime = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-runtime-"));
    root = runtime;
    writeFileSync(
      join(root, "manifest.json"),
      `${JSON.stringify({
        format: 2,
        platform: process.platform,
        arch: "definitely-not-this-architecture",
        target: `${process.platform}-definitely-not-this-architecture`,
        clientVersion: "0.6.0",
        protocolVersion: 12,
        binaryVersion: "0.6.0",
        source: "local-npm:test",
        clientEntry: "client/index.cjs",
        nodeEntry: "client/node.cjs",
        binary: "bin/code-moniker",
        binarySha256: "0".repeat(64),
      })}\n`,
    );

    expect(() => inspectCodeMonikerRuntime(runtime)).toThrow("definitely-not-this-architecture");
  });
});
