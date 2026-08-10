import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plpgsqlRoutineBodyStartLine } from "../src/analysis/plpgsqlDocument.js";
import { classifySqlStatementCount } from "../src/analysis/sqlStatements.js";
import { parseCall, parseSqlCalls, parseSqlDefinitions } from "../src/callParser.js";
import { createCoverageSyntaxService } from "../src/coverage/index.js";
import { extractFuncDeps } from "../src/deps.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

describe("Code Moniker SQL consumers", () => {
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
  }, 30_000);

  afterAll(async () => {
    await codeMoniker?.dispose();
  });

  it("resolves CALL and SELECT debug targets without text heuristics", async () => {
    await expect(parseCall("CALL admin.reindex_all()", codeMoniker.parser)).resolves.toMatchObject({
      schema: "admin",
      routine: "reindex_all",
      kind: "procedure",
    });
    await expect(
      parseCall(
        "SELECT 'CALL fake.target()' AS note, public.real_target(42::int)",
        codeMoniker.parser,
      ),
    ).resolves.toMatchObject({
      schema: "public",
      routine: "real_target",
      args: ["42::int"],
      kind: "function",
    });
    await expect(
      parseCall(
        "WITH sample AS (SELECT public.inner_target(1)) SELECT count(*) FROM public.real_target(42)",
        codeMoniker.parser,
      ),
    ).resolves.toMatchObject({
      schema: "public",
      routine: "real_target",
      args: ["42"],
      kind: "function",
    });
    await expect(
      parseCall("SELECT public.first(); SELECT public.second()", codeMoniker.parser),
    ).rejects.toThrow("exactly one SQL statement");
  });

  it("extracts definitions and launchable call sites from real SQL files", async () => {
    const source = readFileSync(
      join(process.cwd(), "src", "__fixtures__", "functions.sql"),
      "utf8",
    );
    const definitions = await parseSqlDefinitions(source, codeMoniker.parser);
    const calls = await parseSqlCalls(source, codeMoniker.parser);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "test_simple",
      "test_loop",
      "test_inner",
      "test_step_into",
    ]);
    expect(definitions.map((definition) => definition.line)).toEqual([3, 15, 28, 35]);
    expect(definitions[0].params).toEqual([
      { name: "a", type: "int4", mode: "in" },
      { name: "b", type: "text", mode: "in" },
    ]);
    await expect(
      parseSqlDefinitions(
        `CREATE FUNCTION public.defaults(
          required integer,
          optional text DEFAULT 'value',
          equivalent integer = 3,
          OUT result integer
        ) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN required; END $$;`,
        codeMoniker.parser,
      ),
    ).resolves.toMatchObject([
      {
        params: [
          { name: "required", type: "int4", mode: "in" },
          { name: "optional", type: "text", mode: "default" },
          { name: "equivalent", type: "int4", mode: "default" },
        ],
      },
    ]);
    const [variadic] = await parseSqlDefinitions(
      `CREATE FUNCTION app.collect(VARIADIC items integer[])
       RETURNS integer LANGUAGE plpgsql
       AS $$ BEGIN RETURN cardinality(items); END; $$;`,
      codeMoniker.parser,
    );
    const [dollarDefault] = await parseSqlDefinitions(
      `CREATE FUNCTION app.with_default(value text DEFAULT $$fallback$$)
       RETURNS text LANGUAGE plpgsql
       AS $body$ BEGIN RETURN value; END; $body$;`,
      codeMoniker.parser,
    );
    const [singleQuoted] = await parseSqlDefinitions(
      `CREATE FUNCTION app.single_quoted(value text)
       RETURNS text LANGUAGE plpgsql
       AS 'BEGIN RETURN value; END;';`,
      codeMoniker.parser,
    );
    const [quotedType] = await parseSqlDefinitions(
      `CREATE FUNCTION app.with_custom_type(value "App"."ItemCode"[])
       RETURNS text LANGUAGE plpgsql
       AS $$ BEGIN RETURN value::text; END; $$;`,
      codeMoniker.parser,
    );
    expect(variadic?.params).toEqual([{ name: "items", type: "int4[]", mode: "variadic" }]);
    expect(variadic?.body).toBe(" BEGIN RETURN cardinality(items); END; ");
    expect(dollarDefault).toMatchObject({
      schema: "app",
      name: "with_default",
      params: [{ name: "value", type: "text", mode: "default" }],
      body: " BEGIN RETURN value; END; ",
    });
    expect(singleQuoted?.body).toBe("BEGIN RETURN value; END;");
    expect(quotedType?.params).toEqual([{ name: "value", type: '"App"."ItemCode"[]', mode: "in" }]);
    expect(calls).toHaveLength(11);
    expect(calls.find((call) => call.schema === "public")).toMatchObject({
      routine: "test_inner",
      args: ["42"],
      sql: "SELECT public.test_inner(42)",
      isLaunchable: true,
    });
  });

  it("classifies top-level statements while accepting routine bodies", async () => {
    await expect(classifySqlStatementCount("SELECT 1; SELECT 2", codeMoniker.parser)).resolves.toBe(
      "multiple-statements",
    );
    await expect(
      classifySqlStatementCount(
        "CREATE FUNCTION public.answer() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 42; END $$;",
        codeMoniker.parser,
      ),
    ).resolves.toBe("single-statement");
    const nested = `${"coalesce(".repeat(40)}1${", 1)".repeat(40)}`;
    await expect(
      classifySqlStatementCount(`SELECT ${nested}; SELECT 2`, codeMoniker.parser),
    ).resolves.toBe("unclassifiable");
  });

  it("maps routine body lines from the SQL syntax tree", async () => {
    const ddl = `CREATE FUNCTION public.answer()
RETURNS integer
LANGUAGE plpgsql
AS $body$
BEGIN
  RETURN 42;
END;
$body$;`;

    await expect(plpgsqlRoutineBodyStartLine(ddl, codeMoniker.parser)).resolves.toBe(3);
  });

  it("maps a large routine from a deliberately shallow syntax tree", async () => {
    const statements = Array.from({ length: 1_000 }, (_, index) => `  value := ${index};`).join(
      "\n",
    );
    const ddl = `CREATE FUNCTION public.large_subject()
RETURNS integer
LANGUAGE plpgsql
AS $body$
DECLARE value integer := 0;
BEGIN
${statements}
  RETURN value;
END;
$body$;`;
    const bounded = await codeMoniker.parser.parse({
      language: "sql",
      source: ddl,
      maxDepth: 16,
      maxNodes: 512,
      namedOnly: true,
    });

    expect(bounded.truncated).toBe(true);
    await expect(plpgsqlRoutineBodyStartLine(ddl, codeMoniker.parser)).resolves.toBe(3);
  });

  it("extracts schema-qualified dependencies from transient PL/pgSQL", async () => {
    const dependencies = await extractFuncDeps(
      {
        schema: "public_ut",
        name: "test_subject",
        lang: "plpgsql",
        ddl: `CREATE FUNCTION public_ut.test_subject() RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM public.coverage_subject(1);
  RETURN QUERY SELECT public.coverage_wrapper(1);
END;
$body$;`,
      },
      codeMoniker.parser,
    );
    expect([...dependencies]).toEqual(["public.coverage_subject", "public.coverage_wrapper"]);
  });

  it("instruments nested quoted labels without separating a label from its loop", async () => {
    const body = `BEGIN
  <<"outer loop">>
  FOR i IN 1..2 LOOP
    <<"inner loop">>
    LOOP
      EXIT "inner loop";
    END LOOP "inner loop";
  END LOOP "outer loop";
END;`;
    const ddl = `CREATE FUNCTION public.labelled() RETURNS void LANGUAGE plpgsql AS $body$${body}$body$;`;
    const service = createCoverageSyntaxService(async () => codeMoniker.parser);
    const analysis = await service.analyze(body);
    const instrumented = await service.instrument({
      ddl,
      source: body,
      analysis: analysis.analysis,
      runId: "quoted-labels",
    });

    expect(instrumented.body.indexOf("__plpgsql_cov_quoted_labels_l0 := false;")).toBeLessThan(
      instrumented.body.indexOf('<<"outer loop">>'),
    );
    expect(
      instrumented.body.indexOf("RAISE WARNING 'postgresql-workbench-cov:quoted-labels:p0';"),
    ).toBeLessThan(instrumented.body.indexOf('<<"inner loop">>'));
  });
});
