import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDaemonRuntime, type OwnedDaemon } from "@code-moniker/client/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../packages/catalog/src/localCodeMoniker.js";
import { explicitColumnNullability } from "../packages/catalog/src/postgresColumnNullability.js";
import { comparePostgresStructures } from "../packages/catalog/src/postgresSchemaComparison.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";

describe("catalog primary key materialization through the real SQL provider", () => {
  let session: LocalCodeMonikerSession;
  let parser: SyntaxParser;
  let workspace: string;
  let localRuntime: NodeDaemonRuntime | undefined;
  let localDaemon: OwnedDaemon | undefined;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "catalog-comparison-"));
    const binary = process.env.CATALOG_TEST_CODE_MONIKER_BINARY;
    if (binary) {
      localRuntime = new NodeDaemonRuntime();
      localDaemon = await localRuntime.launch({
        workspaceRoots: [workspace],
        binaryCandidates: [binary],
      });
    }
    session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "catalog-comparison-test",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
  }, 30_000);

  afterAll(async () => {
    await session?.dispose();
    if (localRuntime && localDaemon) await localRuntime.stopOwned(localDaemon);
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  const document = (content: string) => [
    { uri: "memory://catalog.sql", language: "sql" as const, content },
  ];
  const compare = (base: string, head: string) =>
    comparePostgresStructures(
      session.client,
      document(base),
      document(head),
      "catalog-materialization",
      "structure",
      parser,
    );

  it("recognizes NOT NULL materialized for an inline primary key", async () => {
    const base = "CREATE TABLE public.probe (id bigint PRIMARY KEY, note text);";
    const head = "CREATE TABLE public.probe (id bigint PRIMARY KEY NOT NULL, note text);";
    const forward = await compare(base, head);
    expect(forward.isomorphic, JSON.stringify(forward)).toBe(true);
    expect((await compare(head, base)).isomorphic).toBe(true);
    const withoutParser = await comparePostgresStructures(
      session.client,
      document(base),
      document(head),
      "conservative",
      "structure",
    );
    expect(withoutParser.isomorphic).toBe(false);
  });

  it("handles composite quoted keys, Unicode offsets and table-local column identities", async () => {
    const base = `CREATE TABLE public.one ("clé" text, "ID" bigint, note text,
PRIMARY KEY ("clé", "ID"));
CREATE TABLE public.two ("clé" text, "ID" bigint);`;
    const head = `CREATE TABLE public.one ("clé" text NOT NULL, "ID" bigint NOT NULL, note text,
PRIMARY KEY ("clé", "ID"));
CREATE TABLE public.two ("clé" text, "ID" bigint);`;
    expect((await compare(base, head)).isomorphic).toBe(true);
    expect(
      (
        await compare(
          base,
          head.replace('public.two ("clé" text', 'public.two ("clé" text NOT NULL'),
        )
      ).isomorphic,
    ).toBe(false);
  });

  it("preserves additions and removals of NOT NULL on non-primary columns", async () => {
    const nullable = "CREATE TABLE public.probe (id bigint PRIMARY KEY, note text);";
    const required =
      "CREATE TABLE public.probe (id bigint NOT NULL PRIMARY KEY, note text NOT NULL);";
    expect((await compare(nullable, required)).isomorphic).toBe(false);
    expect((await compare(required, nullable)).isomorphic).toBe(false);
  });

  it("folds unquoted column names while preserving quoted case", async () => {
    const source = 'CREATE TABLE public.probe (ID bigint, "ID" bigint, PRIMARY KEY (id));';
    const normalized = await explicitColumnNullability(source, parser);
    expect(normalized).toContain('ID bigint\nNOT NULL, "ID" bigint');
    expect(normalized.match(/NOT NULL/g)).toHaveLength(1);
  });

  it("preserves primary key additions and removals", async () => {
    const base = "CREATE TABLE public.probe (id bigint NOT NULL);";
    const head = "CREATE TABLE public.probe (id bigint PRIMARY KEY);";
    expect((await compare(base, head)).isomorphic).toBe(false);
    expect((await compare(head, base)).isomorphic).toBe(false);
  });

  it("normalizes tables nested in CREATE SCHEMA", async () => {
    const base = "CREATE SCHEMA example CREATE TABLE t (id integer PRIMARY KEY);";
    const head = "CREATE SCHEMA example CREATE TABLE t (id integer PRIMARY KEY NOT NULL);";
    expect((await compare(base, head)).isomorphic).toBe(true);
  });

  it("materializes identity nullability without treating generated expressions as identities", async () => {
    const base =
      "CREATE TABLE public.probe (id bigint GENERATED BY DEFAULT AS IDENTITY, value bigint GENERATED ALWAYS AS (CASE WHEN id IS NOT NULL THEN id ELSE 0 END) STORED);";
    const normalized = await explicitColumnNullability(base, parser);
    expect(normalized).toContain("AS IDENTITY\nNOT NULL,");
    expect(normalized).toContain("ELSE 0 END) STORED);");
    expect((await compare(base, normalized)).isomorphic).toBe(true);
    expect((await compare(base, base.replace("STORED", "STORED NOT NULL"))).isomorphic).toBe(false);
  });

  it("proves expression layout while preserving grouping, literal case and casts", async () => {
    const table =
      "CREATE TABLE public.probe (a integer, b integer, c integer, note text, position integer, CHECK ((a + b) * c > 0 AND note <> 'Text'));";
    const same = table
      .replace("position integer", '"position" integer')
      .replace("((a + b) * c > 0 AND note <> 'Text')", "(((a + b) * c) > 0 AND (note <> 'Text'))");
    const result = await compare(table, same);
    expect(result.isomorphic, JSON.stringify(result)).toBe(true);
    for (const changed of [
      table.replace("(a + b) * c", "a + b * c"),
      table.replace("'Text'", "'text'"),
      table.replace("note <>", "note::varchar(2) <>"),
      table.replace("c > 0", "c >= 0"),
    ]) {
      expect((await compare(table, changed)).isomorphic).toBe(false);
    }
    const index =
      "CREATE INDEX probe_idx ON public.probe ((abs(position))) WHERE a > 0 AND b IS NULL;";
    expect(
      (
        await compare(
          table + index,
          table +
            index
              .replace("abs(position)", 'abs("position")')
              .replace("a > 0 AND b IS NULL", "(a > 0) AND (b IS NULL)"),
        )
      ).isomorphic,
    ).toBe(true);
    expect((await compare(table + index, table + index.replace("AND b", "OR b"))).isomorphic).toBe(
      false,
    );
    const boolean =
      "CREATE TABLE public.probe (a boolean, b boolean, c boolean, CHECK ((a OR b) AND c));";
    expect(
      (await compare(boolean, boolean.replace("(a OR b) AND c", "a OR (b AND c)"))).isomorphic,
    ).toBe(false);
    const quoted =
      'CREATE TABLE public.probe ("Case" integer, "case" integer, CHECK ("Case" > 0));';
    expect(
      (await compare(quoted, quoted.replace('CHECK ("Case"', 'CHECK ("case"'))).isomorphic,
    ).toBe(false);
  });

  it("proves typed literals, membership and CASE defaults without erasing real changes", async () => {
    const base =
      "CREATE SCHEMA app; SET search_path = app, pg_catalog; CREATE TYPE app.state AS ENUM ('a', 'b'); CREATE TABLE app.probe (s app.state, note text DEFAULT '', x smallint GENERATED ALWAYS AS (CASE WHEN s = 'a' THEN 1::smallint END) STORED, CHECK (s IN ('a', 'b') AND btrim(note) <> ''));";
    const head = base
      .replace("DEFAULT ''", "DEFAULT ''::text")
      .replace("s = 'a'", "s = 'a'::app.state")
      .replace("1::smallint END", "1::smallint ELSE NULL::smallint END")
      .replace("s IN ('a', 'b')", "s = ANY (ARRAY['a'::app.state, 'b'::app.state])")
      .replace("btrim(note) <> ''", "btrim(note) <> ''::text");
    expect((await compare(base, head)).isomorphic).toBe(true);
    for (const changed of [
      head.replace("ELSE NULL::smallint", "ELSE 2::smallint"),
      head.replace("'b'::app.state", "'a'::app.state"),
      head.replace("DEFAULT ''::text", "DEFAULT 'changed'::text"),
    ])
      expect((await compare(base, changed)).isomorphic).toBe(false);
    const limited = "CREATE TABLE public.probe (value varchar(2), CHECK (value = 'long'));";
    expect(
      (await compare(limited, limited.replace("'long'", "'long'::varchar(2)"))).isomorphic,
    ).toBe(false);
  });

  it("retains differences when schemas can shadow PostgreSQL functions, types or operators", async () => {
    const functionShadow =
      "CREATE SCHEMA app; SET search_path = app, pg_catalog; CREATE FUNCTION app.btrim(value text) RETURNS integer LANGUAGE sql AS 'SELECT 1'; CREATE TABLE app.probe (value text, CHECK (btrim(value) = '1'));";
    expect(
      (await compare(functionShadow, functionShadow.replace("= '1'", "= '1'::text"))).isomorphic,
    ).toBe(false);
    const typeShadow =
      "CREATE SCHEMA app; SET search_path = app, pg_catalog; CREATE DOMAIN app.text AS varchar(2); CREATE TABLE app.probe (value text DEFAULT 'long');";
    expect(
      (
        await compare(
          typeShadow,
          typeShadow.replace("DEFAULT 'long'", "DEFAULT 'long'::pg_catalog.text"),
        )
      ).isomorphic,
    ).toBe(false);
    const unknown =
      "SET search_path = external, pg_catalog; CREATE TABLE public.probe (value pg_catalog.text, CHECK (btrim(value) <> ''));";
    expect((await compare(unknown, unknown.replace("<> ''", "<> ''::text"))).isomorphic).toBe(
      false,
    );
    const stringPath = unknown.replace(
      "search_path = external, pg_catalog",
      "search_path TO 'external, pg_catalog'",
    );
    expect((await compare(stringPath, stringPath.replace("<> ''", "<> ''::text"))).isomorphic).toBe(
      false,
    );
    const unqualifiedDomain = typeShadow
      .replace("DOMAIN app.text", "DOMAIN text")
      .replace("value text DEFAULT", "value pg_catalog.text DEFAULT");
    expect(
      (
        await compare(
          unqualifiedDomain,
          unqualifiedDomain.replace("DEFAULT 'long'", "DEFAULT 'long'::text"),
        )
      ).isomorphic,
    ).toBe(false);
    const composite = typeShadow
      .replace("CREATE DOMAIN app.text AS varchar(2)", "CREATE TABLE app.text (n integer)")
      .replace("DEFAULT 'long'", "DEFAULT '(1)'");
    expect(
      (
        await compare(
          composite,
          composite.replace("DEFAULT '(1)'", "DEFAULT '(1)'::pg_catalog.text"),
        )
      ).isomorphic,
    ).toBe(false);
    const names =
      'CREATE TABLE "a.b".c (value integer, CHECK (value = \'1\')); CREATE TABLE a."b.c" (value text);';
    expect((await compare(names, names.replace("= '1'", "= '1'::text"))).isomorphic).toBe(false);
    const operator =
      "CREATE SCHEMA app; SET search_path = app, pg_catalog; CREATE OPERATOR app.= (FUNCTION = app.eq, LEFTARG = text, RIGHTARG = text); CREATE TABLE app.probe (value text, CHECK (value = 'x'));";
    expect((await compare(operator, operator.replace("= 'x'", "= 'x'::text"))).isomorphic).toBe(
      false,
    );
  });

  it("preserves enum array types and withholds stale column types after ALTER TABLE", async () => {
    const enumDefault =
      "CREATE SCHEMA app; CREATE TYPE app.state AS ENUM ('a', 'b'); CREATE TABLE app.probe (value text DEFAULT pg_typeof(NULL::app.state)::text);";
    expect(
      (await compare(enumDefault, enumDefault.replace("NULL::app.state", "NULL::app.state[]")))
        .isomorphic,
    ).toBe(false);
    const altered =
      "CREATE TABLE public.probe (value text); ALTER TABLE public.probe ALTER COLUMN value TYPE character(3); ALTER TABLE public.probe ADD CHECK (value = 'a ');";
    expect((await compare(altered, altered.replace("= 'a '", "= 'a '::text"))).isomorphic).toBe(
      false,
    );
  });

  it("distinguishes a quoted any function and refuses temporary type resolution", async () => {
    const source = `CREATE FUNCTION public."any"(text[]) RETURNS text LANGUAGE sql AS 'SELECT $1[1]'; CREATE TABLE public.probe (value text, CHECK (value = "any"(ARRAY['a', 'b'])));`;
    expect(
      (await compare(source, source.replace(`= "any"(ARRAY['a', 'b'])`, "IN ('a', 'b')")))
        .isomorphic,
    ).toBe(false);
    const temporary =
      "CREATE TEMP TABLE pg_temp.text (n integer); CREATE TABLE public.probe (value text DEFAULT '(1)');";
    expect(
      (
        await compare(
          temporary,
          temporary.replace("DEFAULT '(1)'", "DEFAULT '(1)'::pg_catalog.text"),
        )
      ).isomorphic,
    ).toBe(false);
  });

  it("withholds equivalence when the provider cannot prove generic-operator grouping", async () => {
    const source =
      "CREATE TABLE public.probe (document jsonb, CHECK (document ->> 'key' = 'value'));";
    expect(
      (await compare(source, source.replace("'key' = 'value'", "('key' = 'value')"))).isomorphic,
    ).toBe(false);
  });

  it("disables typed proofs symmetrically for unmodeled statement effects", async () => {
    const base = "CREATE TABLE public.probe (value text DEFAULT 'x');";
    const head = base.replace("DEFAULT 'x'", "DEFAULT 'x'::text");
    for (const extra of [
      "ALTER TABLE public.probe OWNER TO owner_role;",
      "RESET search_path;",
      "DO $$ BEGIN NULL; END $$;",
      "SELECT public.change_schema();",
      "SET ROLE owner_role;",
    ]) {
      for (const [left, right] of [
        [base + extra, head],
        [base, head + extra],
      ]) {
        const result = await compare(left, right);
        expect(result.isomorphic, extra).toBe(false);
        expect(
          result.diagnostics.some((reason) => reason.includes("Expression context is not proven")),
          extra,
        ).toBe(true);
      }
    }
    const conditional = base.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS");
    expect(
      (await compare(conditional, conditional.replace("DEFAULT 'x'", "DEFAULT 'x'::text")))
        .isomorphic,
    ).toBe(false);
  });

  it("preserves literal whitespace in native signatures", async () => {
    const source = "CREATE TABLE public.probe (value text DEFAULT 'a b', CHECK (value <> 'a b'));";
    expect((await compare(source, source.replaceAll("'a b'", "'a  b'"))).isomorphic).toBe(false);
  });

  it("leaves semantic comparisons unchanged", async () => {
    const result = await comparePostgresStructures(
      session.client,
      document("CREATE TABLE public.probe (id bigint PRIMARY KEY);"),
      document("CREATE TABLE public.probe (id bigint NOT NULL PRIMARY KEY);"),
      "semantic-materialization",
      "semantic",
      parser,
    );
    expect(result.isomorphic).toBe(false);
  });

  it("rejects incomplete syntax and inserts outside trailing line comments", async () => {
    const incomplete = "CREATE TABLE public.probe (id bigint PRIMARY KEY";
    await expect(explicitColumnNullability(incomplete, parser)).rejects.toThrow("syntax errors");
    const source = "CREATE TABLE public.probe (id bigint PRIMARY KEY -- comment\n);";
    const rewritten = await explicitColumnNullability(source, parser);
    expect(rewritten).toContain("NOT NULL");
    expect((await parser.parse({ language: "sql", source: rewritten })).hasError).toBe(false);
    expect(await explicitColumnNullability(rewritten, parser)).toBe(rewritten);
    const valid = await parser.parse({ language: "sql", source });
    await expect(
      explicitColumnNullability(source, {
        parse: async (request) =>
          request.maxDepth === 3 ? parser.parse(request) : { ...valid, truncated: true },
      }),
    ).rejects.toThrow("truncated SQL table declaration");
    await expect(
      explicitColumnNullability(source, {
        parse: async () => ({ ...valid, root: { ...valid.root, children: [] }, truncated: true }),
      }),
    ).rejects.toThrow("complete SQL statement outline");
  });

  it("uses parser-proven ranges around large routine bodies and quoted separators", async () => {
    const routine =
      "CREATE FUNCTION public.large_body() RETURNS void LANGUAGE plpgsql AS $body$\nBEGIN\n" +
      "PERFORM 1; -- CREATE TABLE shadow (x int PRIMARY KEY); é\n".repeat(10_000) +
      "END;\n$body$;\n";
    const table = 'CREATE TABLE public.real_table ("clé" text PRIMARY KEY);';
    const requests: string[] = [];
    const instrumented: SyntaxParser = {
      parse: async (request) => {
        requests.push(`${request.maxDepth ?? "full"}:${Buffer.byteLength(request.source)}`);
        return parser.parse(request);
      },
    };
    const normalized = await explicitColumnNullability(routine + table, instrumented);
    expect(normalized.startsWith(routine)).toBe(true);
    expect(normalized.endsWith('("clé" text PRIMARY KEY\nNOT NULL);')).toBe(true);
    expect(requests).toEqual([
      `3:${Buffer.byteLength(routine + table)}`,
      `full:${Buffer.byteLength(table.slice(0, -1))}`,
    ]);
  });
});
