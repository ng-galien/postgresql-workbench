import { describe, expect, it } from "vitest";
import { PLPGSQL_GRAMMAR_KINDS, SQL_GRAMMAR_KINDS } from "./grammarKinds.js";
import {
  isReservedPostgresSqlKeyword,
  PLPGSQL_KEYWORD_SOURCES,
  PLPGSQL_KEYWORDS,
  POSTGRES_SQL_KEYWORD_SOURCE,
  POSTGRES_SQL_KEYWORDS,
  plpgsqlKeyword,
  postgresSqlKeyword,
} from "./postgresKeywordCatalog.js";

describe("PostgreSQL keyword authority", () => {
  it("identifies the exact official source and runtime grammar", () => {
    expect(POSTGRES_SQL_KEYWORD_SOURCE).toEqual({
      postgresVersion: "18.4",
      sourceTag: "REL_18_4",
      sourceUrl: "https://github.com/postgres/postgres/blob/REL_18_4/src/include/parser/kwlist.h",
      sourceSha256: "fdcdf3694513cba63b4016f63032472b686e381bb35f17c5d645bc2f6f1dac16",
      grammarPackage: "tree-sitter-postgres@1.2.4",
      runtimePackage: "@code-moniker/client@0.9.2",
    });
    expect(PLPGSQL_KEYWORD_SOURCES).toMatchObject({
      postgresVersion: "18.4",
      sourceTag: "REL_18_4",
      reserved: {
        sourceUrl:
          "https://github.com/postgres/postgres/blob/REL_18_4/src/pl/plpgsql/src/pl_reserved_kwlist.h",
        sourceSha256: "32fdee4aebd1ff76283e36d15946dd81c38251baf3cf118545f986df043e9bac",
      },
      unreserved: {
        sourceUrl:
          "https://github.com/postgres/postgres/blob/REL_18_4/src/pl/plpgsql/src/pl_unreserved_kwlist.h",
        sourceSha256: "9c137b1d9e88934aabe57305d933ed7b72144bfed98679b2a7058e4527b7a03c",
      },
    });
  });

  it("preserves every upstream SQL entry, category and bare-label decision", () => {
    expect(POSTGRES_SQL_KEYWORDS).toHaveLength(494);
    expect(new Set(POSTGRES_SQL_KEYWORDS.map(({ word }) => word))).toHaveLength(494);
    expect(
      Object.fromEntries(
        ["U", "C", "T", "R"].map((category) => [
          category,
          POSTGRES_SQL_KEYWORDS.filter((keyword) => keyword.category === category).length,
        ]),
      ),
    ).toEqual({ U: 330, C: 63, T: 23, R: 78 });
    expect(POSTGRES_SQL_KEYWORDS.filter(({ bareLabel }) => !bareLabel)).toHaveLength(39);
    for (const keyword of POSTGRES_SQL_KEYWORDS) {
      expect(keyword.label).toBe(keyword.word.toUpperCase());
    }
  });

  it("preserves the independent PL/pgSQL reserved and unreserved catalogs", () => {
    expect(PLPGSQL_KEYWORDS).toHaveLength(107);
    expect(new Set(PLPGSQL_KEYWORDS.map(({ word }) => word))).toHaveLength(107);
    expect(PLPGSQL_KEYWORDS.filter(({ category }) => category === "R")).toHaveLength(24);
    expect(PLPGSQL_KEYWORDS.filter(({ category }) => category === "U")).toHaveLength(83);
  });

  it("contains every keyword kind the running grammar exposes", () => {
    const catalog = new Set<string>(POSTGRES_SQL_KEYWORDS.map(({ word }) => word));
    const grammarKeywords = SQL_GRAMMAR_KINDS.filter((kind) => kind.startsWith("kw_")).map((kind) =>
      kind.slice(3),
    );
    expect(grammarKeywords.filter((word) => !catalog.has(word))).toEqual([]);
  });

  it("contains every PL/pgSQL keyword kind the running grammar exposes", () => {
    const catalog = new Set<string>(PLPGSQL_KEYWORDS.map(({ word }) => word));
    const grammarKeywords = PLPGSQL_GRAMMAR_KINDS.filter((kind) => kind.startsWith("kw_")).map(
      (kind) => kind.slice(3),
    );
    expect(grammarKeywords.filter((word) => !catalog.has(word))).toEqual([]);
  });

  it("answers identifier quoting from the generated catalog", () => {
    expect(postgresSqlKeyword("SELECT")?.category).toBe("R");
    expect(isReservedPostgresSqlKeyword("select")).toBe(true);
    expect(isReservedPostgresSqlKeyword("abort")).toBe(false);
    expect(plpgsqlKeyword("perform")?.category).toBe("U");
    expect(plpgsqlKeyword("begin")?.category).toBe("R");
  });
});
