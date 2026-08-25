import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BENCHMARK_PROFILES,
  expectedGeneratedCounts,
  npmInvocation,
  parseBenchmarkOptions,
  validateMemorySourceSetContract,
} from "./workbench-index.mjs";

test("npm subprocesses use the current npm CLI on every platform", () => {
  assert.deepEqual(
    npmInvocation(["run", "build:dap"], {
      platformName: "win32",
      nodeExecutable: "C:\\node\\node.exe",
      npmExecutable: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    }),
    {
      executable: "C:\\node\\node.exe",
      args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "run", "build:dap"],
    },
  );
  assert.deepEqual(
    npmInvocation(["run", "build:dap"], {
      platformName: "win32",
      nodeExecutable: "C:\\node\\node.exe",
      npmExecutable: "",
      commandShell: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", "build:dap"],
    },
  );
});

test("the default benchmark profile represents a medium synthetic ERP", () => {
  const options = parseBenchmarkOptions([]);
  assert.equal(options.profileName, "erp-medium");
  assert.deepEqual(options.profile, BENCHMARK_PROFILES["erp-medium"]);
  assert.deepEqual(expectedGeneratedCounts(options.profile), {
    schemas: 20,
    tables: 1_000,
    views: 500,
    functions: 750,
    procedures: 250,
    triggers: 250,
    tableColumns: 12_000,
  });
});

test("the large benchmark profile fits in one Code Moniker source set", () => {
  const profile = BENCHMARK_PROFILES["erp-large"];
  const documentCount =
    1 +
    profile.schemas +
    profile.tables +
    profile.views +
    profile.functions +
    profile.procedures +
    profile.triggers * 2;
  assert.ok(documentCount < 10_000);
});

test("explicit scale overrides remain positive integers", () => {
  const options = parseBenchmarkOptions([
    "--profile",
    "erp-large",
    "--tables=42",
    "--views",
    "12",
    "--skip-build",
  ]);
  assert.equal(options.profile.tables, 42);
  assert.equal(options.profile.views, 12);
  assert.equal(options.profile.schemas, 50);
  assert.equal(options.skipBuild, true);
  assert.equal(options.output, undefined);
  assert.equal(
    parseBenchmarkOptions(["--output", "windows-medium.json"]).output,
    "windows-medium.json",
  );
  assert.throws(() => parseBenchmarkOptions(["--tables", "0"]), /positive integer/);
  assert.throws(() => parseBenchmarkOptions(["--columns", "7"]), /at least 8/);
});

test("PostGIS remains an option of the generic benchmark", () => {
  assert.equal(parseBenchmarkOptions([]).postgis, false);
  assert.equal(parseBenchmarkOptions(["--postgis"]).postgis, true);
});

test("a local PostgreSQL server is an explicit Docker-free fixture", () => {
  assert.equal(parseBenchmarkOptions([]).noDocker, false);
  const options = parseBenchmarkOptions(["--no-docker"]);
  assert.equal(options.noDocker, true);
});

test("the benchmark enforces the instrumented SourceSet contract", () => {
  const initialRefresh = {
    mode: "bulk",
    documents_total: 2,
    added: 2,
    modified: 0,
    removed: 0,
    unchanged: 0,
    extraction_jobs: 2,
    extraction_workers: 2,
    linkage_invocations: 1,
  };
  const incrementalRefresh = {
    mode: "incremental",
    documents_total: 2,
    added: 0,
    modified: 1,
    removed: 0,
    unchanged: 1,
    extraction_jobs: 1,
    extraction_workers: 1,
    linkage_invocations: 1,
  };
  const input = {
    documentCount: 2,
    initialStatus: { generation: 2, timings: { memory_source_refresh: initialRefresh } },
    unchangedStatus: { generation: 2 },
    singleDocumentStatus: {
      generation: 3,
      timings: { memory_source_refresh: incrementalRefresh },
    },
    initialPublication: { generation: 2, message: "source set replaced" },
    unchangedPublication: { generation: 2, message: "source set replaced: unchanged" },
    singleDocumentPublication: { generation: 3, message: "source set replaced" },
  };

  assert.equal(validateMemorySourceSetContract(input), "passed");
  assert.throws(
    () =>
      validateMemorySourceSetContract({
        ...input,
        singleDocumentStatus: {
          generation: 3,
          timings: {
            memory_source_refresh: { ...incrementalRefresh, extraction_jobs: 2 },
          },
        },
      }),
    /extracts exactly one document/,
  );
});
