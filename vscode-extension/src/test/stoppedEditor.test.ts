import * as assert from "node:assert";
import * as vscode from "vscode";
import { PlpgsqlInlineValuesProvider } from "../plpgsqlInlineValues.js";
import { isPostgresqlDapDocument } from "../postgresqlDapSource.js";
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

async function waitForStoppedEditor(
  session: vscode.DebugSession,
  timeoutMs = 15_000,
): Promise<{
  editor: vscode.TextEditor;
  frame: { id: number; line: number; source?: { path?: string; sourceReference?: number } };
}> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "debug session has not exposed a stopped frame";
  while (Date.now() < deadline) {
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads?.threads?.[0]?.id;
      if (threadId !== undefined) {
        const stack = await session.customRequest("stackTrace", { threadId });
        const frame = stack?.stackFrames?.[0];
        const editor = vscode.window.activeTextEditor;
        if (
          frame?.source?.path &&
          editor !== undefined &&
          isPostgresqlDapDocument(editor.document.uri) &&
          editor.document.languageId === "plpgsql" &&
          vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
          vscode.debug.activeStackItem.frameId === frame.id
        ) {
          return { editor, frame };
        }
        lastState = `frame=${frame?.source?.path ?? "<none>"}, editor=${editor?.document.uri.toString() ?? "<none>"}, language=${editor?.document.languageId ?? "<none>"}`;
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Stopped PL/pgSQL editor was not ready after ${timeoutMs}ms: ${lastState}`);
}

async function waitForInlineValuesInvocation(
  calls: string[],
  documentUri: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.includes(documentUri)) return;
    await delay(50);
  }
  throw new Error(
    `Inline values provider was not called for ${documentUri} after ${timeoutMs}ms (calls: ${JSON.stringify(calls)})`,
  );
}

suite("Stopped-frame editor and inline values", function () {
  this.timeout(60_000);

  suiteSetup(async function () {
    if (!(await pgAvailable())) this.skip();
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    if (!ext.isActive) await ext.activate();
  });

  teardown(async () => {
    await stopActivePlpgsqlSession();
  });

  test("editor shown on stop matches frame.source.path and inline values provider fires", async () => {
    const inlineValueCalls: string[] = [];
    const spy = vscode.languages.registerInlineValuesProvider(
      [
        { scheme: "code+moniker" },
        { scheme: "postgresql-dap" },
        { scheme: "debug", language: "plpgsql" },
      ],
      {
        provideInlineValues(doc) {
          inlineValueCalls.push(doc.uri.toString());
          return [];
        },
      },
    );

    try {
      const session = await startPlpgsqlSession(pgConfig("SELECT test_simple(1, 'diag')"));
      const { editor: activeEditor, frame } = await waitForStoppedEditor(session);
      const framePath: string = frame?.source?.path ?? "<none>";
      const active = activeEditor?.document.uri.toString() ?? "<no editor>";

      assert.notStrictEqual(framePath, "<none>", "Frame should carry a source path");
      assert.strictEqual(vscode.Uri.parse(framePath, true).authority, "postgresql");
      assert.match(
        vscode.Uri.parse(framePath, true).path,
        /^\/localhost\/5433\/testdb\/postgres\/session\/[a-f0-9]+\/routine\/\d+\/public\.test_simple$/,
      );
      assert.strictEqual(vscode.Uri.parse(framePath, true).query, "");
      assert.strictEqual(
        frame.source?.sourceReference ?? 0,
        0,
        "The Workbench host must request direct URI resolution instead of a racy debug: source",
      );
      assert.strictEqual(activeEditor?.document.uri.scheme, "postgresql-dap");
      assert.ok(isPostgresqlDapDocument(activeEditor.document.uri));
      assert.strictEqual(activeEditor?.document.languageId, "plpgsql");
      assert.ok(
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame,
        "VS Code must expose the stopped frame through its stable debug API",
      );
      assert.strictEqual(vscode.debug.activeStackItem.frameId, frame.id);
      await waitForInlineValuesInvocation(inlineValueCalls, active);

      // The REAL provider must produce RESOLVED inline texts on the real
      // virtual document — guards against analysis failing on
      // pg_get_functiondef formatting AND against value resolution breaking.
      const editor = activeEditor!;
      const fullRange = new vscode.Range(
        0,
        0,
        editor.document.lineCount - 1,
        editor.document.lineAt(editor.document.lineCount - 1).text.length,
      );
      // Real context, as VS Code provides it: frame id + stopped location.
      const stoppedLine0 = frame.line - 1; // DAP lines are 1-based
      const inlays = await new PlpgsqlInlineValuesProvider(
        extensionSyntaxParser,
      ).provideInlineValues(editor.document, fullRange, {
        frameId: frame.id,
        stoppedLocation: new vscode.Range(stoppedLine0, 0, stoppedLine0, 0),
      } as vscode.InlineValueContext);
      assert.ok(
        inlays.length > 0,
        "Real inline values provider must return inline values for the stopped virtual document",
      );
      const texts = inlays
        .filter((v): v is vscode.InlineValueText => v instanceof vscode.InlineValueText)
        .map((v) => v.text);
      // EXACT inlay multiset at entry stop of test_simple(1, 'diag') — current
      // values on every occurrence plus parameters on the signature line:
      //   signature (line 1):        a = 1, b = diag
      //   DECLARE result/counter:    result = NULL, counter = 0
      //   counter := a + 1;          counter = 0, a = 1   (not executed yet)
      //   result := b || … counter:  result = NULL, b = diag, counter = 0
      //   RETURN result;             result = NULL
      assert.deepStrictEqual(
        [...texts].sort(),
        [
          "a = 1",
          "a = 1",
          "b = diag",
          "b = diag",
          "counter = 0",
          "counter = 0",
          "counter = 0",
          "result = NULL",
          "result = NULL",
          "result = NULL",
        ],
        `Exact entry inlay multiset mismatch, got: ${texts.join(" | ")}`,
      );
    } finally {
      spy.dispose();
    }
  });

  test("full walk: every stop of test_simple is coherent, through termination", async function () {
    this.timeout(90_000);
    const session = await startPlpgsqlSession(pgConfig("SELECT test_simple(1, 'walk')"));
    await delay(6000);

    async function readState(): Promise<{ line: number; counter: string; result: string }> {
      const tid = (await session.customRequest("threads")).threads[0].id;
      const stack = await session.customRequest("stackTrace", { threadId: tid });
      const state = {
        line: stack.stackFrames[0].line as number,
        counter: "<none>",
        result: "<none>",
      };
      const scopes = await session.customRequest("scopes", {
        frameId: stack.stackFrames[0].id,
      });
      for (const scope of scopes.scopes) {
        const vars = await session.customRequest("variables", {
          variablesReference: scope.variablesReference,
        });
        for (const v of vars.variables) {
          if (v.name === "counter") state.counter = v.value;
          if (v.name === "result") state.result = v.value;
        }
      }
      return state;
    }

    // Entry: declarations ran, first statement (line 9) has not.
    assert.deepStrictEqual(await readState(), { line: 9, counter: "0", result: "NULL" });

    const tid = (await session.customRequest("threads")).threads[0].id;
    const trajectory = [
      { line: 10, counter: "2", result: "NULL" }, // counter := a + 1 executed
      { line: 11, counter: "2", result: "walk - 2" }, // result := … executed
    ];
    for (const expected of trajectory) {
      await session.customRequest("next", { threadId: tid });
      await delay(1500);
      assert.deepStrictEqual(await readState(), expected);
    }

    // Stepping RETURN terminates the session cleanly.
    const ended = waitSessionEnd(15_000);
    await session.customRequest("next", { threadId: tid });
    await ended;
  });

  test("record variable produces a resolved inlay on the stopped document", async () => {
    const session = await startPlpgsqlSession(pgConfig("SELECT test_record_var()"));
    await delay(6000);

    const tid = (await session.customRequest("threads")).threads[0].id;
    // Step twice so rec.id/rec.name are assigned before reading values.
    for (let i = 0; i < 2; i++) {
      await session.customRequest("next", { threadId: tid });
      await delay(1500);
    }

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "Stopped document should be shown");
    const fullRange = new vscode.Range(
      0,
      0,
      editor.document.lineCount - 1,
      editor.document.lineAt(editor.document.lineCount - 1).text.length,
    );
    const inlays = await new PlpgsqlInlineValuesProvider(extensionSyntaxParser).provideInlineValues(
      editor.document,
      fullRange,
      {} as vscode.InlineValueContext,
    );
    const texts = inlays
      .filter((v): v is vscode.InlineValueText => v instanceof vscode.InlineValueText)
      .map((v) => v.text);
    assert.ok(
      texts.some((t) => t.startsWith("rec = ")),
      `Expected a resolved 'rec = …' inlay, got: ${texts.join(" | ") || "(none)"}`,
    );

    const ended = waitSessionEnd();
    await vscode.debug.stopDebugging(session);
    await ended.catch(() => {});
  });

  test("standalone frame source is readable without a Code Moniker index", async () => {
    const session = await startPlpgsqlSession({
      ...pgConfig("SELECT test_simple(2, 'scoped')"),
      server: "localhost:5433/testdb:postgres",
    });
    await delay(6000);

    const tid = (await session.customRequest("threads")).threads[0].id;
    const stack = await session.customRequest("stackTrace", { threadId: tid });
    const framePath: string = stack.stackFrames[0]?.source?.path ?? "<none>";

    assert.strictEqual(vscode.Uri.parse(framePath, true).scheme, "postgresql-dap");
    assert.strictEqual(vscode.Uri.parse(framePath, true).authority, "postgresql");
    assert.match(
      vscode.Uri.parse(framePath, true).path,
      /^\/localhost\/5433\/testdb\/postgres\/session\/[a-f0-9]+\/routine\/\d+\/public\.test_simple$/,
    );
    assert.strictEqual(vscode.Uri.parse(framePath, true).query, "");
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.scheme, "postgresql-dap");
    assert.ok(isPostgresqlDapDocument(vscode.window.activeTextEditor!.document.uri));
    assert.strictEqual(vscode.window.activeTextEditor?.document.languageId, "plpgsql");
    assert.ok(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame);
    assert.strictEqual(vscode.debug.activeStackItem.frameId, stack.stackFrames[0].id);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? "", /test_simple/i);

    // Explicit termination — lingering pldbgapi sessions destabilize later tests.
    const ended = waitSessionEnd();
    await vscode.debug.stopDebugging(session);
    await ended.catch(() => {});
  });
});
