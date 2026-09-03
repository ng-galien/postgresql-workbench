import { describe, expect, it } from "vitest";
import {
  CompletionRequest,
  InsertTextFormat,
  SemanticTokensRequest,
} from "vscode-languageserver-protocol";
import { createSqlAuthoringClient, type SqlAuthoringConnection } from "./client.js";

/** A server that answers whatever it is handed, and remembers what it was asked. */
function server(answers: { completion?: unknown; tokens?: unknown }) {
  const asked: { method: string; params: unknown }[] = [];
  const synced: { uri: string; text: string }[] = [];
  const connection: SqlAuthoringConnection = {
    async sendRequest(type, params) {
      asked.push({ method: String(type.method), params });
      return (
        type.method === CompletionRequest.method
          ? (answers.completion ?? null)
          : (answers.tokens ?? null)
      ) as never;
    },
  };
  const client = createSqlAuthoringClient({
    connection,
    legend: () => ["sqlTable", "sqlColumn", "sqlAlias"],
    async sync(uri, text) {
      synced.push({ uri, text });
    },
  });
  return { client, asked, synced };
}

describe("asking the SQL authoring server", () => {
  it("puts the text in front of the server before asking about it", async () => {
    const { client, synced, asked } = server({ completion: [] });
    await client.complete("sql:draft", "SELECT id FROM shop.product", 10);
    expect(synced).toEqual([{ uri: "sql:draft", text: "SELECT id FROM shop.product" }]);
    expect(asked[0]?.method).toBe(CompletionRequest.method);
  });

  it("asks at the line and character the offset falls on", async () => {
    const { client, asked } = server({ completion: [] });
    await client.complete("sql:draft", "SELECT id\nFROM shop.product", 14);
    expect(asked[0]?.params).toMatchObject({ position: { line: 1, character: 4 } });
  });

  it("reads a bare list and a list that says whether it is complete", async () => {
    const bare = server({ completion: [{ label: "price" }] });
    const wrapped = server({ completion: { isIncomplete: false, items: [{ label: "price" }] } });
    const one = await bare.client.complete("sql:draft", "pri", 3);
    const other = await wrapped.client.complete("sql:draft", "pri", 3);
    expect(one).toEqual(other);
    expect(one).toEqual([{ label: "price", insertText: "price", replaceLength: 3 }]);
  });

  it("names the kind the server numbered, without a list of its own to fall behind", async () => {
    const { client } = server({ completion: [{ label: "price", kind: 5 }] });
    const [proposal] = await client.complete("sql:draft", "", 0);
    expect(proposal?.kind).toBe("Field");
  });

  it("replaces what the server says it replaces, and the word at the caret otherwise", async () => {
    const edited = server({
      completion: [
        {
          label: "product",
          textEdit: {
            newText: "product",
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
          },
        },
      ],
    });
    const [byEdit] = await edited.client.complete("sql:draft", "SELECT pro", 10);
    expect(byEdit?.replaceLength).toBe(3);

    const plain = server({ completion: [{ label: "product" }] });
    const [byWord] = await plain.client.complete("sql:draft", "SELECT pro", 10);
    expect(byWord?.replaceLength).toBe(3);
  });

  it("drops a call's placeholders, which name parameters rather than hold values", async () => {
    const { client } = server({
      completion: [
        {
          label: "total",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: an LSP placeholder, not a template.
          insertText: "shop.total(${1:order_id})",
          insertTextFormat: InsertTextFormat.Snippet,
        },
      ],
    });
    const [proposal] = await client.complete("sql:draft", "", 0);
    expect(proposal?.insertText).toBe("shop.total()");
  });

  it("drops a bare tab stop without swallowing what follows it", async () => {
    const { client } = server({
      completion: [
        {
          label: "coalesce",
          insertText: "coalesce($1, $2)",
          insertTextFormat: InsertTextFormat.Snippet,
        },
      ],
    });
    const [proposal] = await client.complete("sql:draft", "", 0);
    expect(proposal?.insertText).toBe("coalesce(, )");
  });

  it("leaves plain text alone, tab stop or not", async () => {
    const { client } = server({
      completion: [{ label: "price", insertText: "price_$1", insertTextFormat: 1 }],
    });
    const [proposal] = await client.complete("sql:draft", "", 0);
    expect(proposal?.insertText).toBe("price_$1");
  });

  it("names each token against the legend the server declared", async () => {
    const { client, asked } = server({ tokens: { data: [0, 7, 7, 0, 0, 0, 8, 5, 1, 0] } });
    const tokens = await client.semanticTokens("sql:draft", "SELECT product.price");
    expect(asked[0]?.method).toBe(SemanticTokensRequest.method);
    expect(tokens).toEqual([
      { line: 0, character: 7, length: 7, type: "sqlTable" },
      { line: 0, character: 15, length: 5, type: "sqlColumn" },
    ]);
  });

  it("answers nothing when the server answers nothing", async () => {
    const { client } = server({});
    expect(await client.complete("sql:draft", "", 0)).toEqual([]);
    expect(await client.semanticTokens("sql:draft", "")).toEqual([]);
  });
});
