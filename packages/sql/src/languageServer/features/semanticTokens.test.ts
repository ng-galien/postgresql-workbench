import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import type {
  PostgresBindingFact,
  PostgresColumnFact,
  PostgresLexicalFact,
  PostgresTypeFact,
} from "../../analysis/documentFacts.js";
import { SQL_SEMANTIC_TOKEN_MODIFIERS, SQL_SEMANTIC_TOKEN_TYPES } from "../legend.js";
import { decodeSemanticTokenData } from "../protocol.js";
import { postgresSemanticTokens } from "./semanticTokens.js";

describe("PostgreSQL semantic tokens", () => {
  it("emits parser-proven PL/pgSQL bindings and lexical facts without a catalog snapshot", () => {
    const source = "DECLARE total CONSTANT bigint; BEGIN total := 1; END";
    const declaration = source.indexOf("total");
    const type = source.indexOf("bigint");
    const reference = source.lastIndexOf("total");
    const facts = [
      binding(source, declaration, "variable", "declaration", true, "plpgsql"),
      typeFact(source, type, "plpgsql"),
      binding(source, reference, "variable", "reference", true, "plpgsql"),
    ] as const;
    const lexical: PostgresLexicalFact[] = [
      {
        regionId: "plpgsql:root",
        language: "plpgsql",
        scopeId: "plpgsql:root",
        kind: "keyword",
        range: { start: 0, end: "DECLARE".length },
      },
    ];

    const tokens = decoded(source, facts, lexical);

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          offset: declaration,
          type: "variable",
          modifiers: ["declaration", "readonly"],
        }),
        expect.objectContaining({ offset: type, type: "type", modifiers: [] }),
        expect.objectContaining({ offset: reference, type: "variable", modifiers: ["readonly"] }),
        expect.objectContaining({ offset: 0, type: "keyword", modifiers: [] }),
      ]),
    );
  });

  it("keeps SQL recovery names out of a bare PL/pgSQL stream", () => {
    const source = "BEGIN missing_name := 1; END";
    const start = source.indexOf("missing_name");
    const sqlRecovery: PostgresColumnFact = {
      regionId: "sql:recovery",
      language: "sql",
      scopeId: "sql:recovery",
      role: "column",
      parts: [part(source, start, "missing_name")],
      range: { start, end: start + "missing_name".length },
      visibility: [
        { scopeId: "sql:recovery", range: { start, end: start + "missing_name".length } },
      ],
    };

    expect(decoded(source, [sqlRecovery], [])).toEqual([]);
  });

  it("emits SQL-wrapper parameter facts while the PL/pgSQL body remains an injection", () => {
    const source =
      "CREATE FUNCTION f(account_id bigint) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN RETURN account_id; END$$";
    const declaration = source.indexOf("account_id");
    const reference = source.lastIndexOf("account_id");
    const type = source.indexOf("bigint");

    expect(
      decoded(
        source,
        [
          binding(source, declaration, "parameter", "declaration", false, "sql"),
          typeFact(source, type, "sql"),
          binding(source, reference, "parameter", "reference", false, "sql"),
        ],
        [],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          offset: declaration,
          type: "parameter",
          modifiers: ["declaration"],
        }),
        expect.objectContaining({ offset: type, type: "sqlType", modifiers: [] }),
        expect.objectContaining({ offset: reference, type: "parameter", modifiers: [] }),
      ]),
    );
  });
});

function binding(
  source: string,
  start: number,
  bindingKind: PostgresBindingFact["bindingKind"],
  use: PostgresBindingFact["use"],
  readonly: boolean,
  language: PostgresBindingFact["language"],
): PostgresBindingFact {
  const written = bindingKind === "parameter" ? "account_id" : "total";
  const range = { start, end: start + written.length };
  return {
    regionId: `${language}:root`,
    language,
    scopeId: `${language}:root`,
    role: "binding",
    bindingKind,
    use,
    readonly,
    parts: [part(source, start, written)],
    range,
    visibility: [{ scopeId: `${language}:root`, range }],
  };
}

function typeFact(
  source: string,
  start: number,
  language: PostgresTypeFact["language"],
): PostgresTypeFact {
  const written = "bigint";
  const range = { start, end: start + written.length };
  return {
    regionId: `${language}:root`,
    language,
    scopeId: `${language}:root`,
    role: "type",
    form: "phrase",
    parts: [part(source, start, written)],
    range,
    visibility: [{ scopeId: `${language}:root`, range }],
  };
}

function part(source: string, start: number, written: string) {
  expect(source.slice(start, start + written.length)).toBe(written);
  return { written, canonical: written, range: { start, end: start + written.length } };
}

function decoded(
  source: string,
  names: readonly (PostgresBindingFact | PostgresColumnFact | PostgresTypeFact)[],
  lexical: readonly PostgresLexicalFact[],
) {
  const document = TextDocument.create("file:///tokens.sql", "sql", 1, source);
  return decodeSemanticTokenData(
    postgresSemanticTokens(document, undefined, names, lexical).data,
  ).map((token) => ({
    offset: document.offsetAt({ line: token.line, character: token.character }),
    length: token.length,
    type: SQL_SEMANTIC_TOKEN_TYPES[token.tokenType],
    modifiers: SQL_SEMANTIC_TOKEN_MODIFIERS.filter(
      (_modifier, index) => (token.tokenModifiers & (1 << index)) !== 0,
    ),
  }));
}
