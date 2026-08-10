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
import { SqlCodeLensProvider } from "../sqlCodeLensProvider.js";
import {
  delay,
  EXT_ID,
  pgAvailable,
  pgConfig,
  startPlpgsqlSession,
  stopActivePlpgsqlSession,
  waitSessionEnd,
} from "./testUtils.js";

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

suite("CodeLens", () => {
  test("exposes call-site debug lenses", async () => {
    const connection = {
      id: "demo-server",
      name: "postgres@localhost:5434/demo",
    };
    const provider = new SqlCodeLensProvider(extensionSyntaxParser, {
      active: () => connection,
      forCall: () => connection,
    });
    const sql = `
CREATE OR REPLACE FUNCTION public.demo(a integer)
RETURNS integer
AS $$ BEGIN RETURN a; END; $$ LANGUAGE plpgsql;

SELECT public.demo(42);
CALL public.run_job(7);
`;
    const document = {
      getText: () => sql,
      uri: vscode.Uri.file("/tmp/calls.sql"),
    } as vscode.TextDocument;

    const lenses = await provider.provideCodeLenses(document);
    const debugCalls = lenses.filter(
      (lens) => lens.command?.command === "postgresql-workbench.debugCall",
    );

    assert.strictEqual(debugCalls.length, 2);
    assert.deepStrictEqual(
      debugCalls.map((lens) => lens.command?.arguments?.[0]?.sql),
      ["SELECT public.demo(42)", "CALL public.run_job(7)"],
    );
    assert.deepStrictEqual(
      debugCalls.map((lens) => lens.command?.arguments?.[0]?.serverId),
      ["demo-server", "demo-server"],
    );
    const comparisons = lenses.filter(
      (lens) => lens.command?.command === "postgresql-workbench.compareRoutineWithDatabase",
    );
    assert.strictEqual(comparisons.length, 1);
    assert.strictEqual(
      comparisons[0].command?.arguments?.[0]?.documentUri,
      document.uri.toString(),
    );
    assert.match(comparisons[0].command?.arguments?.[0]?.sourceSql, /^CREATE OR REPLACE FUNCTION/);
    assert.strictEqual(comparisons[0].command?.arguments?.[0]?.body, " BEGIN RETURN a; END; ");

    const connectionLenses = lenses.filter((lens) =>
      ["postgresql-workbench.pickConnection", "postgresql-workbench.assignCallConnection"].includes(
        lens.command?.command ?? "",
      ),
    );
    assert.strictEqual(connectionLenses.length, 3);
    assert.ok(
      connectionLenses.every(
        (lens) => lens.command?.title === "$(database) postgres@localhost:5434/demo",
      ),
    );
  });

  test("requires a per-callsite connection before exposing debug", async () => {
    const provider = new SqlCodeLensProvider(extensionSyntaxParser);
    const document = {
      getText: () => "SELECT shop.restock_report(10);",
      uri: vscode.Uri.file("/tmp/demo.sql"),
    } as vscode.TextDocument;

    const lenses = await provider.provideCodeLenses(document);

    assert.ok(
      !lenses.some((lens) => lens.command?.command === "postgresql-workbench.debugCall"),
      "Debug should stay hidden until this callsite has a connection",
    );
    const assignment = lenses.find(
      (lens) => lens.command?.command === "postgresql-workbench.assignCallConnection",
    );
    assert.strictEqual(assignment?.command?.title, "$(database) Choose PostgreSQL connection");
    assert.strictEqual(assignment?.command?.arguments?.[0]?.sql, "SELECT shop.restock_report(10)");
  });

  test("hides unsafe call-site lenses that depend on outer SQL context", async () => {
    const provider = new SqlCodeLensProvider(extensionSyntaxParser);
    const document = {
      getText: () => "SELECT public.demo(counter::int);",
      uri: vscode.Uri.file("/tmp/demo.sql"),
    } as vscode.TextDocument;

    const lenses = await provider.provideCodeLenses(document);
    const debugCalls = lenses.filter(
      (lens) => lens.command?.command === "postgresql-workbench.debugCall",
    );

    assert.strictEqual(debugCalls.length, 0);
  });

  test("propagates routine oid for virtual PL/pgSQL documents", async () => {
    const provider = new SqlCodeLensProvider(extensionSyntaxParser);
    const symbolUri = vscode.Uri.parse(
      "code+moniker://./srcset:test/lang:sql/dir:public/dir:routine/module:demo%28integer%29/schema:public/function:demo%28integer%29",
      true,
    );
    const document = {
      uri: symbolUri,
      getText: () =>
        "CREATE OR REPLACE FUNCTION public.demo(a int) RETURNS int AS $$ BEGIN RETURN a; END; $$ LANGUAGE plpgsql;\nSELECT public.demo(42);",
    } as vscode.TextDocument;

    const lenses = await provider.provideCodeLenses(document);
    const debugDefinition = lenses.find(
      (lens) => lens.command?.command === "postgresql-workbench.debugDefinition",
    );

    assert.ok(
      !lenses.some((lens) => lens.command?.command === "postgresql-workbench.debugCall"),
      "Virtual PL/pgSQL documents should not expose debug call CodeLens",
    );
    assert.ok(
      !lenses.some(
        (lens) => lens.command?.command === "postgresql-workbench.compareRoutineWithDatabase",
      ),
      "Deployed virtual routines should not expose a local/database comparison CodeLens",
    );
    assert.ok(debugDefinition, "Expected debug definition CodeLens");
    assert.strictEqual(
      debugDefinition.command?.arguments?.[0]?.symbolUri,
      symbolUri.toString(true),
    );
    assert.strictEqual(debugDefinition.command?.arguments?.[0]?.oid, undefined);
  });
});

suite("Virtual source editing", () => {
  test("writeFile deploys SQL and updates the provider cache", async () => {
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
      activeServer: { id: "srv-1" },
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

      assert.deepStrictEqual(executed, [new TextDecoder().decode(content)]);
      assert.strictEqual(new TextDecoder().decode(cached), new TextDecoder().decode(content));
      assert.ok(changed, "Expected provider change event");
    } finally {
      disposable.dispose();
    }
  });
});

// ============================================================
suite("Debug session e2e", function () {
  this.timeout(120_000);

  suiteSetup(async function () {
    if (!(await pgAvailable())) this.skip();
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    if (!ext.isActive) await ext.activate();
  });

  teardown(async () => {
    await stopActivePlpgsqlSession();
    await delay(1000);
  });

  test("launch → entry stop → threads → stack → scopes → args → locals → step → continue → terminate", async () => {
    // --- Launch ---
    const session = await startPlpgsqlSession(pgConfig("SELECT test_simple(1, 'hello')"));
    assert.strictEqual(session.type, "postgresql-workbench");

    // Wait for DAP to connect + waitForTarget + stop on entry
    await delay(5000);

    // --- Threads ---
    const threads = await session.customRequest("threads");
    assert.ok(threads.threads.length > 0, "Should have threads");
    const tid = threads.threads[0].id;

    // --- Stack Trace ---
    const stack = await session.customRequest("stackTrace", { threadId: tid });
    assert.ok(stack.stackFrames.length > 0, "Should have stack frames");
    const frame = stack.stackFrames[0];
    assert.ok(frame.name.includes("test_simple"), `Expected test_simple, got ${frame.name}`);
    assert.ok(frame.line > 0, "Line should be > 0");

    // --- Scopes ---
    const scopes = await session.customRequest("scopes", { frameId: frame.id });
    assert.ok(scopes.scopes.length >= 2, "Should have >= 2 scopes");
    const argsRef = scopes.scopes[0].variablesReference; // Arguments
    const localsRef = scopes.scopes[1].variablesReference; // Local Variables

    // --- Arguments ---
    const args = await session.customRequest("variables", { variablesReference: argsRef });
    assert.ok(args.variables.length > 0, "Should have arg variables");
    const aVar = args.variables.find((v: any) => v.name === "a");
    assert.ok(aVar, "Missing variable 'a'");
    assert.strictEqual(aVar.value, "1");
    const bVar = args.variables.find((v: any) => v.name === "b");
    assert.ok(bVar, "Missing variable 'b'");
    assert.strictEqual(bVar.value, "hello");

    // --- Local Variables ---
    const locals = await session.customRequest("variables", { variablesReference: localsRef });
    const counter = locals.variables.find((v: any) => v.name === "counter");
    assert.ok(counter, "Missing variable 'counter'");

    // --- Step Over: exact next-line convention with exact value ---
    await session.customRequest("next", { threadId: tid });
    await delay(2000);

    const stack2 = await session.customRequest("stackTrace", { threadId: tid });
    assert.ok(stack2.stackFrames.length > 0);
    assert.strictEqual(
      stack2.stackFrames[0].line,
      frame.line + 1,
      "Step over must advance exactly one line",
    );

    // The stepped-over line was `counter := a + 1` with a=1 — counter is now exactly 2.
    const scopes2 = await session.customRequest("scopes", { frameId: stack2.stackFrames[0].id });
    const locals2 = await session.customRequest("variables", {
      variablesReference: scopes2.scopes[1].variablesReference,
    });
    const counter2 = locals2.variables.find((v: any) => v.name === "counter");
    assert.ok(counter2, "counter should still exist after step");
    assert.strictEqual(
      counter2.value,
      "2",
      "counter must be exactly 2 after stepping its assignment",
    );

    // --- Continue to end ---
    const ended = waitSessionEnd();
    await session.customRequest("continue", { threadId: tid });
    await ended;
    // Session terminated cleanly
  });

  test("step into nested function → verify call stack depth", async () => {
    const session = await startPlpgsqlSession(pgConfig("SELECT test_step_into(5)"));
    await delay(5000);

    const tid = (await session.customRequest("threads")).threads[0].id;

    // Entry stop is already on the call line (result := test_inner(val)) — step into directly
    await session.customRequest("stepIn", { threadId: tid });
    await delay(2000);

    const stack = await session.customRequest("stackTrace", { threadId: tid });
    assert.ok(
      stack.stackFrames.length >= 2,
      `Expected >= 2 frames, got ${stack.stackFrames.length}`,
    );
    assert.ok(
      stack.stackFrames[0].name.includes("test_inner"),
      `Top frame should be test_inner, got ${stack.stackFrames[0].name}`,
    );
    assert.ok(
      stack.stackFrames[1].name.includes("test_step_into"),
      `Caller should be test_step_into, got ${stack.stackFrames[1].name}`,
    );
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      stack.stackFrames[0].source.path,
      "Step into should reveal the newly suspended routine source",
    );

    // Verify x=5 in test_inner
    const scopes = await session.customRequest("scopes", { frameId: stack.stackFrames[0].id });
    const argVars = await session.customRequest("variables", {
      variablesReference: scopes.scopes[0].variablesReference,
    });
    const xVar = argVars.variables.find((v: any) => v.name === "x");
    assert.ok(xVar, "Should have x");
    assert.strictEqual(xVar.value, "5");

    await vscode.window.showTextDocument(vscode.Uri.parse(stack.stackFrames[1].source.path), {
      preview: false,
    });
    await delay(500);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      stack.stackFrames[1].source.path,
      "Manual source navigation must not be overwritten by a stale stack-item callback",
    );

    // Disconnect from the nested frame — mirrors the DAP-level test; a
    // continue-to-end from inside test_inner can outlast the 10s window.
    const ended = waitSessionEnd();
    await vscode.debug.stopDebugging(session);
    await ended;
  });

  test("REPL evaluate SQL expression", async () => {
    const session = await startPlpgsqlSession(pgConfig("SELECT test_simple(10, 'repl')"));
    await delay(5000);

    // Watch variable
    const resp1 = await session.customRequest("evaluate", { expression: "a", context: "watch" });
    assert.strictEqual(resp1.result, "10");

    // REPL SQL
    const resp2 = await session.customRequest("evaluate", {
      expression: "SELECT 1 + 1 AS result",
      context: "repl",
    });
    assert.strictEqual(resp2.result, "2");

    // Terminate
    const ended = waitSessionEnd();
    const tid = (await session.customRequest("threads")).threads[0].id;
    await session.customRequest("continue", { threadId: tid });
    await ended;
  });

  test("breakpoint added via VS Code API stops execution", async function () {
    this.timeout(60_000);
    const session = await startPlpgsqlSession(pgConfig("SELECT test_increments()"));
    await delay(5000);

    const tid = (await session.customRequest("threads")).threads[0].id;
    const stack = await session.customRequest("stackTrace", { threadId: tid });
    const frame = stack.stackFrames[0];
    assert.ok(frame.source?.path, "Frame should carry a Code Moniker source path");
    assert.strictEqual(vscode.Uri.parse(frame.source.path, true).scheme, "code+moniker");

    // Two assignments below the entry stop — steppable by construction.
    const bpLine = frame.line + 2;
    const bp = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.parse(frame.source.path), new vscode.Position(bpLine - 1, 0)),
    );
    vscode.debug.addBreakpoints([bp]);

    try {
      await delay(2000); // let VS Code forward setBreakpoints to the adapter
      await session.customRequest("continue", { threadId: tid });
      await delay(3000);

      const stack2 = await session.customRequest("stackTrace", { threadId: tid });
      assert.ok(stack2.stackFrames.length > 0, "Should still be stopped in the function");
      assert.strictEqual(stack2.stackFrames[0].line, bpLine);
    } finally {
      vscode.debug.removeBreakpoints([bp]);
      const ended = waitSessionEnd();
      await Promise.resolve(session.customRequest("continue", { threadId: tid })).catch(() => {});
      await ended.catch(() => {});
    }
  });

  test("unreachable server terminates the session cleanly", async function () {
    this.timeout(45_000);
    const ended = waitSessionEnd(30_000);
    ended.catch(() => {}); // avoid unhandled rejection on the early-return paths
    let ok: boolean;
    try {
      ok = await vscode.debug.startDebugging(undefined, {
        ...pgConfig("SELECT test_simple(1, 'x')"),
        port: 59_998,
      });
    } catch {
      // The launch error surfaced immediately (test host refuses the error
      // dialog VS Code tries to show) — that IS the clean-failure path.
      return;
    }
    if (!ok) return; // rejected before the adapter started — also a clean failure
    await ended; // must terminate on its own, not hang
  });

  test("record variable is expandable with child fields", async () => {
    const session = await startPlpgsqlSession(pgConfig("SELECT test_record_var()"));
    await delay(5000);

    const tid = (await session.customRequest("threads")).threads[0].id;

    // Step 3 times to fill the record
    for (let i = 0; i < 3; i++) {
      await session.customRequest("next", { threadId: tid });
      await delay(1500);
    }

    const stack = await session.customRequest("stackTrace", { threadId: tid });
    const scopes = await session.customRequest("scopes", { frameId: stack.stackFrames[0].id });
    const locals = await session.customRequest("variables", {
      variablesReference: scopes.scopes[1].variablesReference,
    });
    const rec = locals.variables.find((v: any) => v.name === "rec");
    assert.ok(rec, "Should have 'rec'");
    assert.ok(rec.variablesReference > 0, "Record should be expandable");

    const children = await session.customRequest("variables", {
      variablesReference: rec.variablesReference,
    });
    assert.ok(children.variables.length > 0, "Record should have children");
    const idField = children.variables.find((v: any) => v.name === "id");
    assert.ok(idField, "Should have 'id' field");
    assert.strictEqual(idField.value, "42");

    const ended = waitSessionEnd();
    await session.customRequest("continue", { threadId: tid });
    await ended;
  });
});
