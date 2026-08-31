import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import {
  DEFAULT_PGTAP_TEST_PATTERNS,
  discoverPgTapTests,
  executePgTapTest,
  matchesPgTapTestPatterns,
  type PgTapQueryClient,
  parsePgTapOutput,
  toCoverageTestReport,
} from "./pgtap.js";

const invalidSyntaxParser: SyntaxParser = {
  async parse(request) {
    return {
      file: request.uri ?? "test.sql",
      language: request.language,
      target:
        request.language === "sql"
          ? { language: "sql", entryPoint: "script" }
          : { language: "plpgsql", entryPoint: "block" },
      focus: request.uri ?? "test.sql",
      focusLineRange: null,
      root: {
        kind: "source_file",
        language: request.language,
        named: true,
        error: true,
        missing: false,
        byteRange: [0, request.source.length],
        start: { line: 1, column: 0 },
        end: { line: 1, column: request.source.length },
        text: null,
        children: [],
      },
      emittedNodes: 1,
      totalNodes: 1,
      maxDepth: 1,
      truncated: false,
      hasError: true,
    };
  },
};

describe("pgTAP output", () => {
  it("matches qualified test functions with simple schema.function globs", () => {
    expect(matchesPgTapTestPatterns("public_ut.test_order", DEFAULT_PGTAP_TEST_PATTERNS)).toBe(
      true,
    );
    expect(matchesPgTapTestPatterns("public_it.test_order", DEFAULT_PGTAP_TEST_PATTERNS)).toBe(
      true,
    );
    expect(matchesPgTapTestPatterns("quality.check_order", ["quality.check_*"])).toBe(true);
    expect(matchesPgTapTestPatterns("quality.helper", ["quality.check_*"])).toBe(false);
    expect(matchesPgTapTestPatterns("quality.check_order", [])).toBe(false);
  });

  it("parses passing, failing, skipped, and todo assertions", () => {
    const report = parsePgTapOutput([
      "1..4",
      "ok 1 - passes",
      "not ok 2 - fails\n# have: 1\n# want: 2",
      "ok 3 - unavailable # SKIP optional dependency",
      "not ok 4 - pending # TODO implement later",
    ]);

    expect(report).toMatchObject({
      plan: { first: 1, last: 4 },
      valid: true,
      errors: [],
      passed: 1,
      failed: 1,
      skipped: 1,
      todo: 1,
      total: 4,
    });
    expect(report.assertions.map(({ status }) => status)).toEqual([
      "passed",
      "failed",
      "skipped",
      "todo",
    ]);
  });

  it("adapts skipped and todo assertions without turning them into failures", () => {
    const report = toCoverageTestReport(
      parsePgTapOutput([
        "1..3",
        "ok 1 - passes",
        "ok 2 - skipped # SKIP not supported",
        "not ok 3 - todo # TODO later",
      ]),
    );

    expect(report).toMatchObject({ passed: 3, failed: 0, total: 3 });
    expect(report.tests.every(({ passed }) => passed)).toBe(true);
  });

  it.each([
    [["Bail out! database unavailable"], /Bail out/],
    [["ok 1 - no plan"], /does not contain a test plan/],
    [["1..2", "ok 1 - only one assertion"], /expected 2 assertion/],
    [["1..1", "this is not TAP"], /Unrecognized TAP output/],
    [["1..2", "ok 2 - wrong number", "ok 2 - duplicate"], /does not match expected/],
  ])("rejects malformed TAP output", (lines, expectedError) => {
    const report = parsePgTapOutput(lines);

    expect(report.valid).toBe(false);
    expect(report.errors.join("\n")).toMatch(expectedError);
    expect(toCoverageTestReport(report).failed).toBeGreaterThan(0);
  });

  it("keeps a catalog test discoverable when its stored definition cannot be parsed", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_extension")) return { rows: [{ installed: true }] };
        if (sql.includes("p.proretset")) {
          return {
            rows: [
              {
                oid: "42",
                schema: "public_ut",
                name: "test_unparseable",
                identity_arguments: "",
                language: "plpgsql",
                argument_count: 0,
              },
            ],
          };
        }
        if (sql.includes("p.oid = ANY")) {
          return {
            rows: [
              {
                oid: "42",
                schema: "public_ut",
                name: "test_unparseable",
                identity_arguments: "",
                language: "plpgsql",
                argument_count: 0,
                ddl: "not a valid stored function definition",
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Client;

    await expect(discoverPgTapTests(client, invalidSyntaxParser)).resolves.toMatchObject({
      available: true,
      tests: [
        {
          name: "test_unparseable",
          runnable: true,
          sourceRoutines: [],
        },
      ],
    });
  });

  it("uses indexed routine relations before requesting transient AST dependencies", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_extension")) return { rows: [{ installed: true }] };
        if (sql.includes("p.proretset")) {
          return {
            rows: [
              {
                oid: "42",
                schema: "public_ut",
                name: "test_subject",
                identity_arguments: "",
                language: "plpgsql",
                argument_count: 0,
              },
            ],
          };
        }
        if (sql.includes("WHERE p.oid = ANY")) {
          return {
            rows: [
              {
                oid: "42",
                schema: "public_ut",
                name: "test_subject",
                identity_arguments: "",
                language: "plpgsql",
                argument_count: 0,
                ddl: "definition provided by PostgreSQL",
              },
            ],
          };
        }
        return {
          rows: [
            {
              oid: "7",
              schema: "public",
              name: "subject",
              identity_arguments: "value integer",
              ddl: "definition provided by PostgreSQL",
            },
          ],
        };
      },
    } as unknown as Client;
    const parse = vi.fn(async () => {
      throw new Error("AST must not be requested when the graph relation is available");
    });
    const indexedDependencies = vi.fn(async ({ oid }: { oid: number }) =>
      oid === 42 ? new Set(["public.subject"]) : new Set<string>(),
    );

    const discovery = await discoverPgTapTests(client, { parse }, indexedDependencies);

    expect(discovery.tests[0]?.sourceRoutines).toEqual([
      {
        oid: 7,
        schema: "public",
        name: "subject",
        identityArguments: "value integer",
      },
    ]);
    expect(indexedDependencies).toHaveBeenCalledTimes(2);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not load routine definitions when no configured pattern matches", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("pg_extension")) return { rows: [{ installed: true }] };
        if (sql.includes("p.proretset")) {
          return {
            rows: [
              {
                oid: "42",
                schema: "public_ut",
                name: "test_subject",
                identity_arguments: "",
                language: "plpgsql",
                argument_count: 0,
              },
            ],
          };
        }
        throw new Error(`Definitions must not be loaded: ${sql}`);
      },
    } as unknown as Client;

    await expect(discoverPgTapTests(client, invalidSyntaxParser, undefined, [])).resolves.toEqual({
      available: true,
      tests: [],
    });
    expect(queries).toHaveLength(2);
  });

  it("bounds pgTAP rows and row size before returning output to JavaScript", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return {
          rows: [
            { tap_line: "1..2", line_truncated: false },
            { tap_line: "ok 1 - first", line_truncated: true, row_overflow: false },
            { tap_line: "", line_truncated: false, row_overflow: true },
          ],
        };
      },
    };
    const report = await executePgTapTest(
      client as unknown as PgTapQueryClient,
      {
        oid: 1,
        schema: "public_ut",
        name: "test_bounded",
        identityArguments: "",
        language: "plpgsql",
        runnable: true,
        sourceRoutines: [],
      },
      2,
      16_384,
    );

    expect(queries[0]?.sql).toMatch(/left\(output\.tap_line/);
    expect(queries[0]?.sql).toMatch(/WITH ORDINALITY/);
    expect(queries[0]?.sql).toMatch(/ELSE ''/);
    expect(queries[0]?.sql).toMatch(/LIMIT \(\$1::int \+ 1\)/);
    expect(queries[0]?.values).toEqual([2, 2_048]);
    expect(report).toMatchObject({ truncated: true, valid: false });
    expect(report.errors.join("\n")).toMatch(/configured limit/);

    await executePgTapTest(
      client as unknown as PgTapQueryClient,
      {
        oid: 1,
        schema: "public_ut",
        name: "test_bounded",
        identityArguments: "",
        language: "plpgsql",
        runnable: true,
        sourceRoutines: [],
      },
      2,
      4,
    );
    expect(queries[1]?.values).toEqual([1, 1]);
  });
});
