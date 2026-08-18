import * as assert from "node:assert";
import * as vscode from "vscode";
import { CodeMonikerContentProvider } from "../codeMonikerContentProvider.js";
import { analyzePlpgsqlDocument } from "../plpgsqlDocumentAnalysis.js";
import { PlpgsqlInlineValuesProvider } from "../plpgsqlInlineValues.js";
import {
  PlpgsqlSemanticTokensProvider,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from "../plpgsqlSemanticTokens.js";
import { EXT_ID } from "./testUtils.js";

async function extensionSyntaxParser() {
  const extension = vscode.extensions.getExtension(EXT_ID)!;
  const api = extension.isActive ? extension.exports : await extension.activate();
  return api.workbenchIndex.syntaxParser();
}

// ============================================================
suite("Extension basics", () => {
  test("activates and registers commands", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    assert.ok(ext, "Extension not found");
    if (!ext.isActive) await ext.activate();
    assert.ok(ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    for (const cmd of [
      "postgresql-workbench.addServer",
      "postgresql-workbench.startDockerDebugDatabase",
      "postgresql-workbench.connectServer",
      "postgresql-workbench.removeServer",
      "postgresql-workbench.editServer",
      "postgresql-workbench.changePassword",
      "postgresql-workbench.manageDebugSessions",
      "postgresql-workbench.debugFromTree",
      "postgresql-workbench.openFunction",
      "postgresql-workbench.refreshTests",
      "postgresql-workbench.revealRoutineTests",
      "postgresql-workbench.cancelDatabaseIndex",
    ]) {
      assert.ok(commands.includes(cmd), `Missing: ${cmd}`);
    }
  });

  test("shares one Code Moniker syntax adapter across extension consumers", async () => {
    const extension = vscode.extensions.getExtension(EXT_ID)!;
    const api = extension.isActive ? extension.exports : await extension.activate();
    const [first, second] = await Promise.all([
      api.workbenchIndex.syntaxParser(),
      api.workbenchIndex.syntaxParser(),
    ]);
    assert.strictEqual(first, second);
  });
});

suite("Inline values", () => {
  test("uses parser-known variables instead of SQL keywords", async function () {
    this.timeout(60_000);

    const provider = new PlpgsqlInlineValuesProvider(extensionSyntaxParser);
    const lines = [
      "",
      "CREATE OR REPLACE FUNCTION public.demo(counter integer)",
      "RETURNS integer",
      "AS $$",
      "DECLARE",
      "  result integer;",
      "BEGIN",
      "  SELECT counter::integer INTO result;",
      "  RETURN result;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ];
    const document = {
      uri: { toString: () => "test://inline-values.sql" },
      version: 1,
      getText: () => lines.join("\n"),
      lineAt: (line: number) => ({ text: lines[line] }),
    } as unknown as vscode.TextDocument;

    const values = await provider.provideInlineValues(
      document,
      new vscode.Range(7, 0, 7, lines[7].length),
      {} as vscode.InlineValueContext,
    );

    const lookups = values as vscode.InlineValueVariableLookup[];
    assert.deepStrictEqual(
      lookups.map((value) => value.variableName),
      ["counter", "result"],
    );
  });
});

suite("Semantic tokens", () => {
  test("marks declarations on the body-relative declaration line", async function () {
    this.timeout(60_000);

    const provider = new PlpgsqlSemanticTokensProvider(extensionSyntaxParser);
    // pg_get_functiondef layout: LANGUAGE in the header, body opens on line 3
    const lines = [
      "CREATE OR REPLACE FUNCTION public.demo(counter integer)",
      " RETURNS integer",
      " LANGUAGE plpgsql",
      "AS $function$",
      "DECLARE",
      "  result integer;",
      "BEGIN",
      "  SELECT counter::integer INTO result;",
      "  RETURN result;",
      "END;",
      "$function$",
    ];
    const document = {
      uri: { toString: () => "test://semantic-tokens.sql" },
      version: 1,
      getText: () => lines.join("\n"),
    } as unknown as vscode.TextDocument;

    const tokens = await provider.provideDocumentSemanticTokens(document);
    assert.ok(tokens, "Expected semantic tokens");

    // Decode [deltaLine, deltaStart, length, tokenType, tokenModifiers] runs
    const decoded: { line: number; char: number; length: number; type: string; mods: number }[] =
      [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i];
      char = tokens.data[i] === 0 ? char + tokens.data[i + 1] : tokens.data[i + 1];
      decoded.push({
        line,
        char,
        length: tokens.data[i + 2],
        type: TOKEN_TYPES[tokens.data[i + 3]],
        mods: tokens.data[i + 4],
      });
    }

    const declBit = 1 << TOKEN_MODIFIERS.indexOf("declaration");
    const declarations = decoded.filter(
      (t) => t.type === "variable" && (t.mods & declBit) !== 0 && t.length === "result".length,
    );
    assert.deepStrictEqual(
      declarations.map((t) => ({ line: t.line, char: t.char })),
      [{ line: 5, char: 2 }],
      "Declaration token should land on the 'result integer;' line",
    );
  });
});

suite("Code Moniker PL/pgSQL document analysis", () => {
  test("handles parameters, quoted bodies, DO blocks, and composite record assignments", async function () {
    this.timeout(60_000);
    const source = `CREATE FUNCTION public.inline_fn(input_id integer)
RETURNS test_record
LANGUAGE plpgsql
AS 'DECLARE rec test_record; BEGIN rec.id := input_id; RETURN rec; END';

CREATE FUNCTION public.escaped_fn()
RETURNS integer
LANGUAGE plpgsql
AS E'DECLARE\n  escaped_value integer := 1;\nBEGIN\n  RETURN escaped_value;\nEND';

DO $block$
DECLARE
  do_value integer := 1;
BEGIN
  RAISE NOTICE '%', do_value;
END;
$block$;`;
    const document = {
      uri: { toString: () => "test://code-moniker-document.sql" },
      version: 1,
      getText: () => source,
    };

    const routines = await analyzePlpgsqlDocument(document, await extensionSyntaxParser());

    assert.strictEqual(routines.length, 3);
    assert.deepStrictEqual(
      routines.map((routine) => routine.variables.map((variable) => variable.name)),
      [["input_id", "rec"], ["escaped_value"], ["do_value"]],
    );
  });
});

suite("Virtual source editing", () => {
  test("writeFile stores a working copy without deploying SQL", async () => {
    const executed: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        executed.push(sql);
        return { rows: [] };
      },
    };
    const symbolUri = vscode.Uri.parse(
      "code+moniker://./srcset:test/lang:sql/dir:public/dir:routine/module:demo%28%29/schema:public/function:demo%28%29",
      true,
    );
    const fakeConnections = {
      getClient: () => fakeClient,
      onServerChanged: () => new vscode.Disposable(() => {}),
    };
    const fakeIndex = {
      onDidChangeState: () => new vscode.Disposable(() => {}),
      sourceDocumentUris: () => [symbolUri],
      sourceDescriptorForDocumentUri: (uri: vscode.Uri) =>
        uri.toString() === symbolUri.toString()
          ? {
              symbolUri: symbolUri.toString(true),
              sourceUri: "postgresql://srv-1/demo/public/routine/demo().sql",
              serverId: "srv-1",
              database: "demo",
              schema: "public",
              documentKind: "routine",
              oid: 123,
              name: "demo",
              signature: "",
              symbolKind: "function",
              plpgsql: true,
              revision: "test",
              generation: 1,
              content: "",
            }
          : undefined,
      sourceDescriptor: (uri: string) =>
        uri === symbolUri.toString(true)
          ? {
              symbolUri: uri,
              sourceUri: "postgresql://srv-1/demo/public/routine/demo().sql",
              serverId: "srv-1",
              database: "demo",
              schema: "public",
              documentKind: "routine",
              oid: 123,
              name: "demo",
              signature: "",
              symbolKind: "function",
              plpgsql: true,
              revision: "test",
              generation: 1,
              content: "",
            }
          : undefined,
    };
    const provider = new CodeMonikerContentProvider(fakeConnections as never, fakeIndex as never);
    const uri = symbolUri;
    const content = new TextEncoder().encode(
      "CREATE OR REPLACE FUNCTION public.demo() RETURNS int AS $$ BEGIN RETURN 2; END; $$ LANGUAGE plpgsql;",
    );

    let changed = false;
    const disposable = provider.onDidChangeFile(() => {
      changed = true;
    });

    try {
      await provider.writeFile(uri, content);
      const cached = await provider.readFile(uri);

      assert.deepStrictEqual(executed, []);
      assert.strictEqual(new TextDecoder().decode(cached), new TextDecoder().decode(content));
      assert.ok(changed, "Expected provider change event");
    } finally {
      disposable.dispose();
    }
  });
});
