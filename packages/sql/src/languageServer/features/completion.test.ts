import { describe, expect, it } from "vitest";
import { CompletionItemKind } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { PostgresCompletionPlan } from "../../authoring/completion.js";
import { projectedSqlDocument } from "../documentProjection.js";
import { postgresCompletionList } from "./completion.js";

function document(source: string, prefix = "") {
  return projectedSqlDocument(
    TextDocument.create("file:///query.sql", "sql", 1, source),
    prefix ? { prefix, suffix: ")", revision: "1" } : undefined,
  );
}

describe("postgresCompletionList", () => {
  it("projects only proposals selected by the autonomous planner", () => {
    const plan: PostgresCompletionPlan = {
      status: "available",
      isIncomplete: false,
      proposals: [
        {
          kind: "keyword",
          label: "AND",
          insertion: { kind: "text", text: "AND" },
          documentReplacementRange: { start: 34, end: 36 },
          source: {
            kind: "grammar-terminal",
            language: "sql",
            keyword: "AND",
            authority: {
              postgresRef: "REL_18_4",
              generator: { name: "gnu-bison", version: "3.8.2" },
              grammarDigest: "grammar",
              scannerDigest: "scanner",
              keywordDigest: "keywords",
              predictorDigest: "predictor",
              projectionDigest: "projection",
            },
          },
          rankGroup: 2,
        },
      ],
    };
    const source = "SELECT id FROM shop.address WHERE an";

    expect(postgresCompletionList(plan, document(source))).toMatchObject({
      isIncomplete: false,
      items: [
        {
          label: "AND",
          kind: CompletionItemKind.Keyword,
          textEdit: {
            range: { start: { line: 0, character: 34 }, end: { line: 0, character: 36 } },
            newText: "AND",
          },
        },
      ],
    });
  });

  it("projects analysis ranges back into an embedded Monaco document", () => {
    const prefix = "SELECT * FROM shop.address WHERE (";
    const plan: PostgresCompletionPlan = {
      status: "available",
      isIncomplete: false,
      proposals: [
        {
          kind: "column",
          label: "label",
          insertion: { kind: "text", text: "address.label" },
          documentReplacementRange: { start: prefix.length, end: prefix.length + 3 },
          source: {
            kind: "catalog-object",
            language: "sql",
            slot: "column",
            scopeId: "sql:root",
            snapshot: {
              connectionId: "test",
              database: "demo",
              revision: "1",
              generation: 1,
            },
            object: { oid: 1, kind: "table", schema: "shop", name: "address" },
          },
          rankGroup: 0,
        },
      ],
    };

    expect(postgresCompletionList(plan, document("lab", prefix)).items[0]?.textEdit).toEqual({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      newText: "address.label",
    });
  });

  it("renders structured calls as LSP snippets", () => {
    const plan: PostgresCompletionPlan = {
      status: "available",
      isIncomplete: false,
      proposals: [
        {
          kind: "routine",
          label: "archive_address",
          insertion: {
            kind: "call",
            callee: "shop.archive_address",
            arguments: [{ placeholder: "address_id" }],
          },
          documentReplacementRange: { start: 5, end: 5 },
          source: {
            kind: "catalog-object",
            language: "sql",
            slot: "routine",
            scopeId: "sql:root",
            snapshot: {
              connectionId: "test",
              database: "demo",
              revision: "1",
              generation: 1,
            },
            object: {
              oid: 2,
              kind: "function",
              schema: "shop",
              name: "archive_address",
            },
          },
          rankGroup: 1,
        },
      ],
    };

    expect(postgresCompletionList(plan, document("CALL ")).items[0]).toMatchObject({
      insertTextFormat: 2,
      textEdit: { newText: "shop.archive_address($" + "{1:address_id})" },
    });
  });
});
