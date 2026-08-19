import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BENCHMARK_PROFILES,
  expectedGeneratedCounts,
  parseBenchmarkOptions,
  validateMemorySourceSetContract,
} from "./workbench-index-benchmark.mjs";

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
  assert.throws(() => parseBenchmarkOptions(["--tables", "0"]), /positive integer/);
  assert.throws(() => parseBenchmarkOptions(["--columns", "7"]), /at least 8/);
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
