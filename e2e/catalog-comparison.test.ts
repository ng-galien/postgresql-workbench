import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../packages/catalog/src/localCodeMoniker.js";
import { explicitPrimaryKeyNullability } from "../packages/catalog/src/postgresPrimaryKeyNullability.js";
import { comparePostgresStructures } from "../packages/catalog/src/postgresSchemaComparison.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";

describe("catalog primary key materialization through the real SQL provider", () => {
  let session: LocalCodeMonikerSession;
  let parser: SyntaxParser;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "catalog-comparison-"));
    session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "catalog-comparison-test",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
  }, 30_000);

  afterAll(async () => {
    await session?.dispose();
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
    const normalized = await explicitPrimaryKeyNullability(source, parser);
    expect(normalized).toContain('ID bigint\nNOT NULL, "ID" bigint');
    expect(normalized.match(/NOT NULL/g)).toHaveLength(1);
  });

  it("preserves primary key additions and removals", async () => {
    const base = "CREATE TABLE public.probe (id bigint NOT NULL);";
    const head = "CREATE TABLE public.probe (id bigint PRIMARY KEY);";
    expect((await compare(base, head)).isomorphic).toBe(false);
    expect((await compare(head, base)).isomorphic).toBe(false);
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
    await expect(explicitPrimaryKeyNullability(incomplete, parser)).rejects.toThrow(
      "syntax errors",
    );
    const source = "CREATE TABLE public.probe (id bigint PRIMARY KEY -- comment\n);";
    const rewritten = await explicitPrimaryKeyNullability(source, parser);
    expect(rewritten).toContain("NOT NULL");
    expect((await parser.parse({ language: "sql", source: rewritten })).hasError).toBe(false);
    expect(await explicitPrimaryKeyNullability(rewritten, parser)).toBe(rewritten);
    const valid = await parser.parse({ language: "sql", source });
    await expect(
      explicitPrimaryKeyNullability(source, {
        parse: async (request) =>
          request.maxDepth === 3 ? parser.parse(request) : { ...valid, truncated: true },
      }),
    ).rejects.toThrow("truncated SQL table declaration");
    await expect(
      explicitPrimaryKeyNullability(source, {
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
    const normalized = await explicitPrimaryKeyNullability(routine + table, instrumented);
    expect(normalized.startsWith(routine)).toBe(true);
    expect((await compare(routine + table, normalized)).isomorphic).toBe(true);
    expect(normalized.endsWith('("clé" text PRIMARY KEY\nNOT NULL);')).toBe(true);
    expect(requests).toEqual([
      `3:${Buffer.byteLength(routine + table)}`,
      `full:${Buffer.byteLength(table.slice(0, -1))}`,
    ]);
  });
  it("normalizes tables nested in CREATE SCHEMA", async () => {
    const base = "CREATE SCHEMA example CREATE TABLE t (id integer PRIMARY KEY);";
    const head = "CREATE SCHEMA example CREATE TABLE t (id integer PRIMARY KEY NOT NULL);";
    expect((await compare(base, head)).isomorphic).toBe(true);
  });
});
