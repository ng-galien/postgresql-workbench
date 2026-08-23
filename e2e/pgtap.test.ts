import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverPgTapTests, executePgTapTest } from "../packages/coverage/src/index.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "testdb",
  user: "postgres",
  password: "postgres",
};

describe("e2e: pgTAP discovery and execution", () => {
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
  }, 30_000);

  afterAll(async () => {
    await codeMoniker?.dispose();
  });

  it("discovers default test patterns and maps AST dependencies to routines", async () => {
    await withClient(PG_CONFIG, async (client) => {
      const discovery = await discoverPgTapTests(client, codeMoniker.parser);
      expect(discovery.available).toBe(true);
      expect(discovery.tests.map(({ schema, name }) => `${schema}.${name}`)).toEqual([
        "public_it.test_coverage_integration",
        "public_ut.test_coverage_error",
        "public_ut.test_coverage_failure",
        "public_ut.test_coverage_invalid_tap",
        "public_ut.test_coverage_mapped_error",
        "public_ut.test_coverage_slow",
        "public_ut.test_coverage_subject",
        "public_ut.test_requires_argument",
      ]);

      const subject = discovery.tests.find(({ name }) => name === "test_coverage_subject");
      expect(subject?.sourceRoutines.map(({ identityArguments }) => identityArguments)).toEqual([
        "value integer",
        "value text",
      ]);
      expect(subject?.sourceRoutines.some(({ schema }) => schema === "public_ut")).toBe(false);

      const slow = discovery.tests.find(({ name }) => name === "test_coverage_slow");
      expect(slow?.sourceRoutines).toMatchObject([
        { schema: "public", name: "coverage_subject", identityArguments: "value integer" },
        { schema: "public", name: "coverage_subject", identityArguments: "value text" },
      ]);

      const integration = discovery.tests.find(({ name }) => name === "test_coverage_integration");
      expect(integration?.sourceRoutines).toMatchObject([
        { schema: "public", name: "coverage_subject", identityArguments: "value integer" },
        { schema: "public", name: "coverage_subject", identityArguments: "value text" },
        { schema: "public", name: "coverage_wrapper", identityArguments: "value integer" },
      ]);
      expect(discovery.tests.find(({ name }) => name === "test_requires_argument")?.runnable).toBe(
        false,
      );
    });
  });

  it("discovers tests from a custom schema.function pattern", async () => {
    await withClient(PG_CONFIG, async (client) => {
      const discovery = await discoverPgTapTests(client, codeMoniker.parser, undefined, [
        "quality.check_*",
      ]);

      expect(discovery.tests).toHaveLength(1);
      expect(discovery.tests[0]).toMatchObject({
        schema: "quality",
        name: "check_coverage_subject",
        runnable: true,
        sourceRoutines: expect.arrayContaining([
          expect.objectContaining({ schema: "public", name: "coverage_subject" }),
        ]),
      });
      expect(discovery.tests[0]?.sourceRoutines.some(({ schema }) => schema === "quality")).toBe(
        false,
      );
    });
  });

  it("executes passing and failing pgTAP functions", async () => {
    const discovery = await withClient(PG_CONFIG, (client) =>
      discoverPgTapTests(client, codeMoniker.parser),
    );
    const passing = requiredTest(discovery.tests, "test_coverage_subject");
    const failing = requiredTest(discovery.tests, "test_coverage_failure");
    await withClient(PG_CONFIG, async (client) => {
      await expect(executePgTapTest(client, passing)).resolves.toMatchObject({
        passed: 4,
        failed: 0,
        total: 4,
      });
    });
    await withClient(PG_CONFIG, async (client) => {
      await expect(executePgTapTest(client, failing)).resolves.toMatchObject({
        passed: 0,
        failed: 1,
        total: 1,
      });
    });
  });

  it("surfaces pgTAP function errors and rejects tests requiring arguments", async () => {
    await withClient(PG_CONFIG, async (client) => {
      const discovery = await discoverPgTapTests(client, codeMoniker.parser);
      const erroring = requiredTest(discovery.tests, "test_coverage_error");
      const malformed = requiredTest(discovery.tests, "test_coverage_invalid_tap");
      const parameterized = requiredTest(discovery.tests, "test_requires_argument");

      await expect(executePgTapTest(client, erroring)).rejects.toThrow(
        /intentional pgTAP execution error/,
      );
      await expect(executePgTapTest(client, parameterized)).rejects.toThrow(/requires arguments/);
      await expect(executePgTapTest(client, malformed)).resolves.toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expect.stringMatching(/Unrecognized TAP output/)]),
      });
    });
  });

  it("reports pgTAP as unavailable in a database where it is not installed", async () => {
    await withClient({ ...PG_CONFIG, database: "postgres" }, async (client) => {
      await expect(discoverPgTapTests(client, codeMoniker.parser)).resolves.toEqual({
        available: false,
        tests: [],
      });
    });
  });
});

async function withClient<T>(
  config: typeof PG_CONFIG,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(config);
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

function requiredTest(
  tests: Awaited<ReturnType<typeof discoverPgTapTests>>["tests"],
  name: string,
) {
  const test = tests.find((candidate) => candidate.name === name);
  if (!test) throw new Error(`Missing pgTAP test ${name}`);
  return test;
}
