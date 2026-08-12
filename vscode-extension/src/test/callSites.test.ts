import * as assert from "node:assert";
import { Client } from "pg";
import * as vscode from "vscode";
import { debugApplicationName } from "../../../src/debugger/launch/debugApplicationName.js";
import type { DebugResult, DebugResultError } from "../../../src/debugger/launch/debugResult.js";
import type { ExtensionDebugSessionSnapshot } from "../debugSessionController.js";
import {
  debugBackendSelections,
  listDebugSessions,
  terminateDebugSessions,
} from "../debugSessionRecovery.js";
import type { PlpgsqlExtensionApi } from "../extension.js";
import { isPostgresqlDapDocument } from "../postgresqlDapSource.js";
import type { WorkbenchGraphRenderEvidence } from "../workbenchGraph/protocol.js";
import type {
  DebugSessionsItem,
  ExtensionGroupItem,
  FunctionItem,
  PlpgsqlTreeItem,
  SchemaItem,
  SourcesSnapshotItem,
  WorkbenchObjectItem,
  WorkbenchRelationGroupItem,
  WorkbenchRelationTargetItem,
  WorkbenchTableMemberItem,
} from "../workbenchTreeProvider.js";
import {
  delay,
  EXT_ID,
  pgAvailable,
  pgConfig,
  stopActivePlpgsqlSession,
  waitForSessionStart,
  waitSessionEnd,
} from "./testUtils.js";

const SERVER_ID = "localhost:5433/testdb:postgres";

async function sourceChildren(api: PlpgsqlExtensionApi) {
  const root = await api.treeProvider.getChildren();
  const server = root.find(
    (item) => item.kind === "server" && api.connectionManager.isActiveServer(item.server.id),
  );
  assert.ok(server, "Workbench should expose the active PostgreSQL server");
  const database = (await api.treeProvider.getChildren(server)).find(
    (item) => item.kind === "databaseSource",
  );
  assert.ok(database, "Workbench should expose the active PostgreSQL database context");
  const sources = (await api.treeProvider.getChildren(database)).find(
    (item) => item.kind === "sourcesSnapshot",
  );
  assert.ok(sources, "Database context should expose its Sources snapshot");
  return api.treeProvider.getChildren(sources);
}

async function waitForWorkbenchObject(
  api: PlpgsqlExtensionApi,
  schema: SchemaItem,
  name: string,
  expected: boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let indexed = false;
  let visible = false;
  while (Date.now() < deadline) {
    indexed = api.treeProvider
      .searchObjects(name, 500)
      .some((object) => object.schema === schema.schema && object.name === name);
    visible = (await api.treeProvider.getChildren(schema)).some(
      (item) => (item.kind === "function" || item.kind === "object") && item.object.name === name,
    );
    if (indexed === expected && visible === expected) return;
    await delay(50);
  }
  throw new Error(
    `Workbench object ${schema.schema}.${name} did not become expected=${expected}; ` +
      `indexed=${indexed}, visible=${visible}, index=${api.workbenchIndex.state.status}`,
  );
}

async function connectionChildren(api: PlpgsqlExtensionApi) {
  const root = await api.connectionTreeProvider.getChildren();
  const server = root.find((item) => item.kind === "server");
  assert.ok(server, "Connections should expose the registered server");
  const database = (await api.connectionTreeProvider.getChildren(server)).find(
    (item) => item.kind === "databaseSource",
  );
  assert.ok(database);
  return api.connectionTreeProvider.getChildren(database);
}

/** Walk the source tree once: database → schema "public" → its functions. */
let cachedFunctions: FunctionItem[] | undefined;
async function publicFunctions(api: PlpgsqlExtensionApi): Promise<FunctionItem[]> {
  if (cachedFunctions) return cachedFunctions;
  const tree = api.treeProvider;
  const schemas = await sourceChildren(api);
  const pub = schemas.find((item) => item.kind === "schema" && item.schema === "public");
  assert.ok(pub, `Tree should list schema 'public', got ${schemas.map((s) => s.label).join(",")}`);
  cachedFunctions = (await tree.getChildren(pub)).filter(
    (item): item is FunctionItem => item.kind === "function",
  );
  return cachedFunctions;
}

async function waitForRoutineFrame(
  session: vscode.DebugSession,
  routine: string,
  timeoutMs = 5_000,
): Promise<{ threadId: number; source: string; elapsedMs: number }> {
  const startedAt = Date.now();
  let lastSource = "<none>";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const threads = await session.customRequest("threads");
      const threadId = threads.threads[0]?.id;
      if (threadId !== undefined) {
        const stack = await session.customRequest("stackTrace", { threadId });
        const frame = stack.stackFrames.find((candidate: { name?: string }) =>
          candidate.name?.includes(routine),
        );
        lastSource = frame?.source?.path ?? lastSource;
        if (frame?.source?.path) {
          return {
            threadId,
            source: frame.source.path,
            elapsedMs: Date.now() - startedAt,
          };
        }
      }
    } catch {}
    await delay(50);
  }
  throw new Error(
    `The DAP frame for ${routine} did not expose a source within ${timeoutMs}ms; ` +
      `last source=${lastSource}`,
  );
}

async function waitForSuccessfulResult(api: PlpgsqlExtensionApi, sql: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = api.resultStore.selected;
    if (result?.query?.includes(sql)) return result;
    await delay(50);
  }
  throw new Error(
    `No successful result for ${sql}; selected=${api.resultStore.selectedEntry?.query ?? "<none>"}`,
  );
}

async function waitForGraphAck(
  api: PlpgsqlExtensionApi,
  prefix: string,
  renderId: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      api.workbenchGraph.webviewAcks.some(
        (ack) => ack.prefix === prefix && ack.renderId === renderId,
      )
    ) {
      return;
    }
    await delay(50);
  }
  throw new Error(`The graph webview did not render scope ${prefix} within ${timeoutMs}ms`);
}

async function waitForRenderedGraph(
  api: PlpgsqlExtensionApi,
  prefix: string,
  renderId: number,
  afterWebviewRenderId = 0,
  timeoutMs = 10_000,
): Promise<WorkbenchGraphRenderEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acknowledgements = api.workbenchGraph.webviewAcks;
    for (let index = acknowledgements.length - 1; index >= 0; index -= 1) {
      const ack = acknowledgements[index];
      if (
        ack.prefix === prefix &&
        ack.renderId === renderId &&
        ack.webviewRenderId > afterWebviewRenderId
      ) {
        return ack.rendered;
      }
    }
    await delay(50);
  }
  throw new Error(`The graph webview did not expose rendered DOM evidence for ${prefix}`);
}

function currentDebugSession(api: PlpgsqlExtensionApi): ExtensionDebugSessionSnapshot | undefined {
  return api.debugSessions.active;
}

async function waitForDebugSessionState(
  api: PlpgsqlExtensionApi,
  state: ExtensionDebugSessionSnapshot["state"],
  timeoutMs = 5_000,
): Promise<ExtensionDebugSessionSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = currentDebugSession(api);
    if (session?.state === state) return session;
    await delay(25);
  }
  throw new Error(
    `Extension debug session did not reach ${state} within ${timeoutMs}ms; ` +
      `current=${currentDebugSession(api)?.state ?? "<none>"}`,
  );
}

async function resetShopFixture(api: PlpgsqlExtensionApi): Promise<void> {
  const client = api.connectionManager.getClient();
  assert.ok(client, "The extension connection should be available");
  await client.query(`
    TRUNCATE shop.order_line RESTART IDENTITY;
    UPDATE shop.product
    SET stock = CASE id
      WHEN 1 THEN 12
      WHEN 2 THEN 8
      WHEN 3 THEN 0
      WHEN 4 THEN 42
    END;
    UPDATE shop.customer
    SET loyalty_points = CASE id
      WHEN 1 THEN 120
      WHEN 2 THEN 0
      WHEN 3 THEN 45
    END
  `);
}

suite("Command call sites (registered server)", function () {
  this.timeout(120_000);
  let api: PlpgsqlExtensionApi;

  suiteSetup(async function () {
    if (!(await pgAvailable())) this.skip();
    const ext = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXT_ID)!;
    api = await ext.activate();
    assert.ok(api?.connectionManager, "activate() must return the extension API");
    await api.callSiteConnections.clearAll();
    await api.connectionManager.store.add(
      {
        id: SERVER_ID,
        name: "postgres@localhost:5433/testdb",
        host: "localhost",
        port: 5433,
        database: "testdb",
        user: "postgres",
      },
      "postgres",
    );

    const serverItem = (await api.treeProvider.getChildren()).find(
      (item) => item.kind === "server" && item.server.id === SERVER_ID,
    );
    assert.ok(serverItem, "The inline connection action should receive its ServerItem context");
    const ok = await vscode.commands.executeCommand(
      "postgresql-workbench.connectServer",
      serverItem,
    );
    assert.strictEqual(ok, true, "connectServer should succeed");
  });

  suiteTeardown(async () => {
    await stopActivePlpgsqlSession();
    if (!api) return;
    await api.connectionManager.store.remove(SERVER_ID).catch(() => {});
  });

  teardown(async () => {
    await stopActivePlpgsqlSession();
  });

  test("server registered via store + connectServer command", async () => {
    assert.ok(api.connectionManager.isConnected);
    assert.strictEqual(api.connectionManager.activeServer?.id, SERVER_ID);
  });

  test("checkRequirements reports pldbgapi available", async () => {
    const check = await api.connectionManager.checkRequirements();
    assert.ok(check, "checkRequirements should return a result");
    assert.strictEqual(check!.available, true, `pldbgapi should be available: ${check!.error}`);
    // The command itself must run without throwing (its message is fire-and-forget).
    await vscode.commands.executeCommand("postgresql-workbench.checkRequirements");
  });

  test("the existing explorer is replaced by the indexed Workbench tree", async () => {
    const result = await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    assert.ok(
      result,
      `Indexing the active database should succeed: ${api.workbenchIndex.state.message ?? api.workbenchIndex.state.status}`,
    );
    const connectionRoot = await api.connectionTreeProvider.getChildren();
    assert.ok(connectionRoot.some((item) => item.kind === "server"));
    const sources = await sourceChildren(api);
    assert.ok(
      sources.every(
        (item) =>
          item.kind !== "schema" ||
          (item.schema !== "information_schema" && !item.schema.startsWith("pg_")),
      ),
      "System schemas must stay outside the primary PostgreSQL source tree",
    );
    assert.ok(
      sources.every((item) => item.kind === "schema"),
      "Sources should expose schemas directly without a redundant index-status level",
    );
    const shop = sources.find((item) => item.kind === "schema" && item.schema === "shop");
    assert.ok(shop, "The Workbench tree should include schemas returned by Code Moniker");
    const shopObjects = await api.treeProvider.getChildren(shop);
    const shopTable = shopObjects.find(
      (item) =>
        item.kind === "object" && item.object.kind === "table" && item.object.name === "product",
    );
    assert.ok(
      shopTable,
      "The Workbench tree should include PostgreSQL tables returned by Code Moniker",
    );
    assert.strictEqual((shopTable.iconPath as vscode.ThemeIcon).id, "table");

    const publicSchema = sources.find((item) => item.kind === "schema" && item.schema === "public");
    assert.ok(publicSchema);
    const publicObjects = await api.treeProvider.getChildren(publicSchema);
    const pgtap = publicObjects.find(
      (item): item is ExtensionGroupItem =>
        item.kind === "extensionGroup" && item.extension === "pgtap",
    );
    assert.ok(pgtap, "Extension-owned pgTAP routines should be grouped below public");
    assert.strictEqual((pgtap.iconPath as vscode.ThemeIcon).id, "extensions");
    assert.ok(
      pgtap.objects.length > 100,
      `The pgTAP group should retain indexed extension objects: ${pgtap.objects.length}`,
    );
    assert.ok(
      publicObjects
        .filter((item) => item.kind === "function" || item.kind === "object")
        .every(
          (item) => api.workbenchIndex.objectOrigin(item.object.sourceUri)?.kind !== "extension",
        ),
      "Extension-owned objects must not flood the primary schema level",
    );

    const funcs = await publicFunctions(api);
    const names = funcs.map((f) => f.funcName);
    assert.ok(
      names.includes("test_simple"),
      `Expected test_simple in tree, got ${names.join(",")}`,
    );
    assert.ok(names.includes("test_proc"), `Expected test_proc (procedure) in tree`);
    const indexedRoutine = funcs.find((func) => func.funcName === "test_simple");
    assert.strictEqual(
      indexedRoutine?.command?.command,
      undefined,
      "Selecting a routine node must stay neutral; its explicit action opens the definition",
    );
  });

  test("propagates committed CREATE and DROP DDL into an expanded Sources branch", async () => {
    const client = api.connectionManager.getClient();
    assert.ok(client, "The extension connection should be available");
    await client.query("DROP TABLE IF EXISTS shop.workbench_ddl_sync_probe");
    await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");

    let provisioningInstalled = false;
    try {
      await api.workbenchDdlSync.setConnectionEnabled(SERVER_ID, true);
      await api.workbenchDdlSync.provision(SERVER_ID);
      provisioningInstalled = true;
      const listeningDeadline = Date.now() + 10_000;
      while (
        api.workbenchDdlSync.state(SERVER_ID).status !== "listening" &&
        Date.now() < listeningDeadline
      ) {
        await delay(50);
      }
      assert.strictEqual(
        api.workbenchDdlSync.state(SERVER_ID).status,
        "listening",
        "The test DatabaseContext must be listening before external DDL",
      );

      const root = await api.treeProvider.getChildren();
      const server = root.find((item) => item.kind === "server" && item.server.id === SERVER_ID);
      assert.ok(server);
      const database = (await api.treeProvider.getChildren(server)).find(
        (item) => item.kind === "databaseSource",
      );
      assert.ok(database);
      const sources = (await api.treeProvider.getChildren(database)).find(
        (item): item is SourcesSnapshotItem => item.kind === "sourcesSnapshot",
      );
      assert.ok(sources);
      const shop = (await api.treeProvider.getChildren(sources)).find(
        (item): item is SchemaItem => item.kind === "schema" && item.schema === "shop",
      );
      assert.ok(shop);
      api.treeProvider.getTreeItem(sources);
      api.treeProvider.setExpanded(sources, true);
      api.treeProvider.getTreeItem(shop);
      api.treeProvider.setExpanded(shop, true);
      await api.treeProvider.getChildren(shop);

      const treeEvents: Array<PlpgsqlTreeItem | undefined> = [];
      const subscription = api.treeProvider.onDidChangeTreeData((item) => treeEvents.push(item));
      try {
        await client.query(`
          CREATE TABLE shop.workbench_ddl_sync_probe (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            label text NOT NULL
          )
        `);
        await waitForWorkbenchObject(api, shop, "workbench_ddl_sync_probe", true);

        assert.ok(
          treeEvents.some((item) => item?.kind === "schema" && item.schema === "shop"),
          "The already materialized shop branch must receive the DDL refresh",
        );
        assert.ok(
          !treeEvents.includes(undefined),
          "A committed table DDL must not replace the complete Workbench tree",
        );

        treeEvents.length = 0;
        await client.query("DROP TABLE shop.workbench_ddl_sync_probe");
        await waitForWorkbenchObject(api, shop, "workbench_ddl_sync_probe", false);
        assert.ok(
          treeEvents.some((item) => item?.kind === "schema" && item.schema === "shop"),
          "Dropping the table must refresh the same materialized shop branch",
        );
      } finally {
        subscription.dispose();
      }
    } finally {
      await client.query("DROP TABLE IF EXISTS shop.workbench_ddl_sync_probe");
      if (provisioningInstalled) {
        await api.workbenchDdlSync.removeProvisioning(SERVER_ID).catch(() => undefined);
      }
      await api.workbenchDdlSync.setConnectionEnabled(SERVER_ID, false).catch(() => undefined);
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    }
  });

  test("reconnects and republishes the database after its owned daemon exits", async function () {
    const before = api.workbenchIndex.daemonRuntime;
    if (!before?.owned) {
      this.skip();
      return;
    }
    process.kill(before.pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (api.workbenchIndex.daemonRuntime && Date.now() < deadline) await delay(50);
    assert.ok(!api.workbenchIndex.daemonRuntime);

    const result = await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    assert.ok(result, "Indexing should reconnect without reloading the extension");
    const after = api.workbenchIndex.daemonRuntime as { pid: number; owned: boolean } | undefined;
    assert.notStrictEqual(after?.pid, before.pid);
    assert.strictEqual(api.workbenchIndex.state.status, "available");
  });

  test("tree header search button opens an indexed PostgreSQL definition", async () => {
    const extension = vscode.extensions.getExtension(EXT_ID);
    assert.ok(extension, "PostgreSQL Workbench extension should be installed");
    const packageJson = extension.packageJSON as {
      contributes?: {
        menus?: {
          "view/title"?: Array<{ command: string; group?: string; when?: string }>;
        };
      };
    };
    const searchButton = packageJson.contributes?.menus?.["view/title"]?.find(
      (item) =>
        item.command === "postgresql-workbench.searchDatabaseObjects" &&
        item.when === "view == postgresql-workbench-connections",
    );
    assert.ok(searchButton, "The Workbench tree header should contribute its search command");
    assert.strictEqual(searchButton.group, "navigation@2");

    assert.ok(await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase"));
    const primedUri = await vscode.commands.executeCommand<vscode.Uri>(
      searchButton.command,
      "shop product table",
    );
    assert.ok(primedUri, "The deterministic search hook should prime the last query");

    const object = api.treeProvider.searchObjects("shop product table", 10)[0];
    assert.ok(object, "The indexed table should be available as a TreeView object");
    const treeContext = api.treeProvider.itemForObject(object);
    assert.ok(treeContext, "The search click should receive the active TreeView context");
    const searchFromHeader = vscode.commands.executeCommand<vscode.Uri>(
      searchButton.command,
      treeContext,
    );
    let searchSettled = false;
    void searchFromHeader.then(
      () => {
        searchSettled = true;
      },
      () => {
        searchSettled = true;
      },
    );
    await delay(100);
    assert.strictEqual(searchSettled, false, "A real header click should keep its picker open");
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    assert.strictEqual(
      await searchFromHeader,
      undefined,
      "Closing the picker should cancel a real header search without treating its context as text",
    );
    assert.strictEqual(api.workbenchSearchQuery(), "shop product table");
  });

  test("search opens the exact indexed PostgreSQL definition", async () => {
    assert.ok(await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase"));
    const uri = await vscode.commands.executeCommand<vscode.Uri>(
      "postgresql-workbench.searchDatabaseObjects",
      "shop product table",
    );

    assert.ok(uri, "Searching an indexed table should open its definition");
    assert.strictEqual(uri!.scheme, "code+moniker");
    const document = vscode.window.activeTextEditor?.document;
    assert.strictEqual(document?.uri.toString(), uri!.toString());
    assert.match(document?.getText() ?? "", /CREATE TABLE "shop"\."product"/i);
    const documentProjection = JSON.parse(uri!.query) as {
      identity: string;
      label: string;
    };
    assert.strictEqual(
      documentProjection.label,
      "testdb/shop/table/product",
      "Breadcrumbs must use the shared human-readable PostgreSQL path",
    );
    assert.strictEqual(uri!.path, "/testdb/shop/table/product");
    const activeTabLabel = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? "";
    assert.match(activeTabLabel, /product/);
    assert.doesNotMatch(activeTabLabel, /srcset:|code\+moniker/);
    const descriptor = api.workbenchIndex.sourceDescriptorForDocumentUri(uri!);
    assert.ok(descriptor, "The canonical URI must resolve through the shared registry");
    assert.strictEqual(documentProjection.identity, descriptor.symbolUri);
    assert.strictEqual(descriptor.symbolUri, api.workbenchIndex.symbol(descriptor.symbolUri)?.uri);
    assert.strictEqual(descriptor.revision, api.workbenchIndex.state.result?.revision);
    assert.strictEqual(descriptor.serverId, SERVER_ID);
    assert.strictEqual(
      api.workbenchSearchQuery(),
      "shop product table",
      "Reopening search should restore the previous Workbench query",
    );
  });

  test("canonical Code Moniker source is a readable VS Code file", async () => {
    assert.ok(await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase"));
    const object = api.treeProvider.searchObjects("shop product table", 500)[0];
    assert.ok(object);
    const uri = api.workbenchIndex.documentUri(object.symbolUri);
    assert.ok(uri);
    const descriptor = api.workbenchIndex.sourceDescriptorForDocumentUri(uri);
    assert.ok(descriptor);
    assert.strictEqual(descriptor.symbolUri, object.symbolUri);
    const stat = await vscode.workspace.fs.stat(uri);
    assert.strictEqual(stat.type, vscode.FileType.File);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.match(document.getText(), /CREATE TABLE "shop"\."product"/i);
  });

  test("executes only the SQL selection through the shared results panel", async () => {
    const indexedBefore = api.workbenchIndex.state.result;
    assert.ok(indexedBefore);
    const document = await vscode.workspace.openTextDocument({
      language: "sql",
      content: [
        "SELECT 7::integer AS value;",
        "CREATE TEMP TABLE u11_selection_probe (id integer);",
        "SELECT * FROM u11_missing_table;",
        "SELECT 1 AS first; SELECT 2 AS second;",
      ].join("\n"),
    });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const executeLine = async (line: number) => {
      const text = document.lineAt(line).text;
      editor.selection = new vscode.Selection(
        new vscode.Position(line, 0),
        new vscode.Position(line, text.length),
      );
      return vscode.commands.executeCommand<DebugResult | DebugResultError>(
        "postgresql-workbench.executeSqlSelection",
      );
    };

    try {
      const selected = await executeLine(0);
      assert.ok(selected && "command" in selected);
      assert.strictEqual(selected.command, "SELECT");
      assert.strictEqual(selected.rowCount, 1);
      assert.deepStrictEqual(selected.rows, [[{ kind: "number", value: "7" }]]);
      assert.strictEqual(selected.source?.uri, document.uri.toString());
      assert.strictEqual(selected.source?.line, 1);
      assert.strictEqual(api.resultStore.selected?.id, selected.id);

      const command = await executeLine(1);
      assert.ok(command && "command" in command);
      assert.strictEqual(command.command, "CREATE");
      assert.strictEqual(command.rowCount, 0);
      assert.deepStrictEqual(command.rows, []);

      const failure = await executeLine(2);
      assert.ok(failure && "status" in failure);
      assert.strictEqual(failure.status, "error");
      assert.match(failure.message, /u11_missing_table.*does not exist/i);
      assert.strictEqual(api.resultStore.selectedEntry?.id, failure.id);

      const resultCount = api.resultStore.size;
      assert.strictEqual(await executeLine(3), false);
      assert.strictEqual(api.resultStore.size, resultCount);

      editor.selection = new vscode.Selection(0, 0, 0, 0);
      assert.strictEqual(
        await vscode.commands.executeCommand("postgresql-workbench.executeSqlSelection"),
        false,
      );
      assert.strictEqual(api.resultStore.size, resultCount);
      assert.strictEqual(
        api.workbenchIndex.state.result?.generation,
        indexedBefore!.generation,
        "Normal SQL execution must not rebuild the Code Moniker database index",
      );
      assert.notStrictEqual(vscode.debug.activeDebugSession?.type, "plpgsql");
    } finally {
      await api.connectionManager
        .getClient()
        ?.query("DROP TABLE IF EXISTS pg_temp.u11_selection_probe");
    }
  });

  test("compares the exact overloaded local routine with the deployed snapshot", async () => {
    const indexedBefore = api.workbenchIndex.state.result;
    assert.ok(indexedBefore);
    const client = api.connectionManager.getClient();
    assert.ok(client);
    const resolved = await client.query<{
      definition: string;
      integer_oid: number;
      text_oid: number;
    }>(`
      SELECT
        pg_get_functiondef('public.coverage_subject(integer)'::regprocedure::oid) AS definition,
        'public.coverage_subject(integer)'::regprocedure::oid::integer AS integer_oid,
        'public.coverage_subject(text)'::regprocedure::oid::integer AS text_oid
    `);
    const deployed = resolved.rows[0];
    assert.ok(deployed);
    assert.notStrictEqual(deployed.integer_oid, deployed.text_oid);

    const compare = async (content: string) => {
      const document = await vscode.workspace.openTextDocument({ language: "sql", content });
      await vscode.window.showTextDocument(document, { preview: false });
      const lenses =
        (await vscode.commands.executeCommand<vscode.CodeLens[]>(
          "vscode.executeCodeLensProvider",
          document.uri,
        )) ?? [];
      const comparison = lenses.find(
        (lens) => lens.command?.command === "postgresql-workbench.compareRoutineWithDatabase",
      );
      assert.ok(comparison, "Expected a local/database routine comparison CodeLens");
      return vscode.commands.executeCommand<{
        status: "identical" | "different";
        oid: number;
        identity: string;
      }>(comparison.command!.command, ...(comparison.command!.arguments ?? []));
    };

    const identical = await compare(deployed.definition);
    assert.deepStrictEqual(identical, {
      status: "identical",
      oid: deployed.integer_oid,
      identity: '"public"."coverage_subject"(int4)',
    });
    const modifiedSource = deployed.definition.replace(
      /\bBEGIN\b/i,
      "BEGIN\n  -- local-only comparison change",
    );
    assert.notStrictEqual(modifiedSource, deployed.definition);
    const different = await compare(modifiedSource);
    assert.deepStrictEqual(different, {
      status: "different",
      oid: deployed.integer_oid,
      identity: '"public"."coverage_subject"(int4)',
    });
    const staleConnection = await vscode.commands.executeCommand(
      "postgresql-workbench.compareRoutineWithDatabase",
      {
        schema: "public",
        name: "coverage_subject",
        params: [{ name: "value", type: "int4", mode: "in" }],
        line: 1,
        kind: "function",
        sourceSql: deployed.definition,
        body: "BEGIN RETURN value; END;",
        serverId: "stale-server",
      },
    );
    assert.strictEqual(
      staleConnection,
      false,
      "A CodeLens bound to another server must not compare against the active database",
    );
    assert.strictEqual(
      api.workbenchIndex.state.result?.generation,
      indexedBefore.generation,
      "Routine comparison must not rebuild the Code Moniker database index",
    );
  });

  test("offers only contextual actions supported by the indexed object", async () => {
    const result = api.workbenchIndex.state.result;
    assert.ok(result);
    const table = api.treeProvider.searchObjects("shop product table", 10)[0];
    assert.ok(table);
    assert.deepStrictEqual(
      (await api.workbenchObjectActions(table!)).map((action) => action.id),
      ["open-definition", "open-graph"],
    );

    const functions = await publicFunctions(api);
    const withoutTests = functions.find((item) => item.funcName === "test_simple");
    assert.ok(withoutTests);
    assert.deepStrictEqual(
      (await api.workbenchObjectActions(withoutTests!.object)).map((action) => action.id),
      ["open-definition", "open-deployed-source", "open-graph", "debug"],
      "An unmapped PL/pgSQL routine must not expose dead pgTAP actions",
    );

    const covered = functions.find(
      (item) =>
        item.funcName === "coverage_subject" &&
        item.params.some((param) => /int/i.test(param.type)),
    );
    assert.ok(covered, "The indexed coverage fixture should include its integer routine");
    assert.deepStrictEqual(
      (await api.workbenchObjectActions(covered!.object)).map((action) => action.id),
      [
        "open-definition",
        "open-deployed-source",
        "open-graph",
        "debug",
        "show-tests",
        "run-tests",
        "run-with-coverage",
      ],
    );
    assert.strictEqual(
      await api.runWorkbenchObjectAction("show-tests", covered!.object, {
        revision: result!.revision,
        generation: result!.generation,
      }),
      true,
      "The contextual action should delegate to the existing native Test Explorer mapping",
    );
  });

  test("runs, covers, and cancels mapped pgTAP actions through native profiles", async () => {
    const client = api.connectionManager.getClient();
    assert.ok(client);
    await client!.query("DROP SCHEMA IF EXISTS u24_ut CASCADE");
    await client!.query("DROP FUNCTION IF EXISTS public.u24_subject(integer)");
    await client!.query(`
      CREATE OR REPLACE FUNCTION public.u24_subject(value integer)
      RETURNS integer
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN value * 2;
      END;
      $$;

      CREATE SCHEMA u24_ut;
      CREATE OR REPLACE FUNCTION u24_ut.test_u24_subject()
      RETURNS SETOF text
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEXT is(public.u24_subject(2), 4, 'contextual test run');
      END;
      $$;
    `);
    try {
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
      api.coverageTests.refresh();
      const routine = api.treeProvider.searchObjects("u24 subject function", 10)[0];
      const result = api.workbenchIndex.state.result;
      assert.ok(routine && result);
      assert.ok(
        (await api.workbenchObjectActions(routine!)).some(
          (action) => action.id === "run-with-coverage",
        ),
      );
      const snapshot = {
        revision: result!.revision,
        generation: result!.generation,
      };
      assert.strictEqual(await api.runWorkbenchObjectAction("run-tests", routine!, snapshot), true);
      assert.strictEqual(
        await api.runWorkbenchObjectAction("run-with-coverage", routine!, snapshot),
        true,
      );

      await client!.query(`
        CREATE OR REPLACE FUNCTION u24_ut.test_u24_subject()
        RETURNS SETOF text
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM public.u24_subject(2);
          PERFORM pg_sleep(20);
          RETURN NEXT pass('cancelled before completion');
        END;
        $$;
      `);
      api.coverageTests.refresh();
      const cancellation = new vscode.CancellationTokenSource();
      const completed = new Promise<ReadonlyMap<string, string>>((resolve) => {
        const subscription = api.coverageTests.onDidCompleteRun((outcomes) => {
          subscription.dispose();
          resolve(outcomes);
        });
      });
      const startedAt = Date.now();
      setTimeout(() => cancellation.cancel(), 150);
      try {
        assert.strictEqual(
          await api.coverageTests.runRoutineTests(
            routine!.serverId,
            routine!.oid,
            false,
            cancellation.token,
          ),
          true,
        );
      } finally {
        cancellation.dispose();
      }
      const outcomes = await completed;
      assert.ok(
        [...outcomes.values()].some((outcome) => outcome === "skipped"),
        "Cancelling the contextual run should skip its active pgTAP test",
      );
      assert.ok(
        Date.now() - startedAt < 15_000,
        "Cancellation should settle within its bounded fallback before the twenty-second query completes",
      );
    } finally {
      await client!.query("DROP SCHEMA IF EXISTS u24_ut CASCADE");
      await client!.query("DROP FUNCTION IF EXISTS public.u24_subject(integer)");
      api.coverageTests.refresh();
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    }
  });

  test("search distinguishes overloaded routines and rejects a stale snapshot", async () => {
    const overloaded = await vscode.commands.executeCommand<vscode.Uri>(
      "postgresql-workbench.searchDatabaseObjects",
      "public coverage_subject text function",
    );
    assert.ok(overloaded, "The text overload should be selected exactly");
    assert.match(
      vscode.window.activeTextEditor?.document.getText() ?? "",
      /FUNCTION public\.coverage_subject\(value text\)/i,
    );

    const client = api.connectionManager.getClient();
    assert.ok(client);
    await client!.query("DROP TABLE IF EXISTS public.u21_generation_probe");
    await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    const object = api.treeProvider.searchObjects("shop product table", 10)[0];
    const previous = api.workbenchIndex.state.result;
    assert.ok(object && previous);
    await client!.query("CREATE TABLE public.u21_generation_probe (id integer PRIMARY KEY)");
    try {
      const refreshed = await vscode.commands.executeCommand<
        typeof api.workbenchIndex.state.result
      >("postgresql-workbench.indexActiveDatabase");
      assert.ok(refreshed);
      assert.notStrictEqual(
        refreshed!.generation,
        previous!.generation,
        "A changed catalog should create a new Code Moniker generation",
      );

      const stale = await vscode.commands.executeCommand<vscode.Uri>(
        "postgresql-workbench.openDatabaseObject",
        object,
        { revision: previous!.revision, generation: previous!.generation },
      );
      assert.strictEqual(stale, undefined, "Objects from an earlier generation must be rejected");
    } finally {
      await client!.query("DROP TABLE IF EXISTS public.u21_generation_probe");
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    }
  });

  test("renders PostgreSQL cards and links in the graph webview", async () => {
    const client = api.connectionManager.getClient();
    assert.ok(client);
    let productNodeId: string | undefined;
    await client!.query("DROP SCHEMA IF EXISTS u22_graph CASCADE");
    await client!.query("CREATE SCHEMA u22_graph");
    await client!.query(`
      CREATE TABLE u22_graph.u22_product_source (
        id integer PRIMARY KEY,
        name text NOT NULL
      )
    `);
    await client!.query(`
      CREATE VIEW u22_graph.u22_product_view AS
      SELECT product.id, product.name
      FROM u22_graph.u22_product_source AS product
    `);
    await client!.query(`
      CREATE TABLE u22_graph.u22_order_source (
        id integer PRIMARY KEY,
        product_id integer NOT NULL,
        CONSTRAINT u22_order_product_fk
          FOREIGN KEY (product_id) REFERENCES u22_graph.u22_product_source(id)
      )
    `);
    await client!.query(`
      CREATE FUNCTION u22_graph.u22_audit_product()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER u22_product_audit
      AFTER INSERT ON u22_graph.u22_product_source
      FOR EACH ROW EXECUTE FUNCTION u22_graph.u22_audit_product();
    `);
    try {
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
      const result = api.workbenchIndex.state.result;
      assert.ok(result, "The Workbench graph test requires a current indexed snapshot");
      const sources = await sourceChildren(api);
      const graphSchema = sources.find(
        (item) => item.kind === "schema" && item.schema === "u22_graph",
      );
      assert.ok(graphSchema);
      const graphObjects = await api.treeProvider.getChildren(graphSchema);
      const view = graphObjects.find(
        (item): item is WorkbenchObjectItem =>
          item.kind === "object" &&
          item.object.kind === "view" &&
          item.object.name === "u22_product_view",
      );
      assert.ok(view, "The indexed view should be present in the existing Workbench tree");

      const table = graphObjects.find(
        (item): item is WorkbenchObjectItem =>
          item.kind === "object" &&
          item.object.kind === "table" &&
          item.object.name === "u22_product_source",
      );
      assert.ok(table, "The indexed table should be present in the Workbench tree");
      const trigger = graphObjects.find(
        (item): item is WorkbenchObjectItem =>
          item.kind === "object" &&
          item.object.kind === "trigger" &&
          item.object.name === "u22_product_audit",
      );
      assert.ok(trigger, "The indexed trigger should be present in the Workbench tree");
      const auditRoutine = graphObjects.find(
        (item): item is FunctionItem =>
          item.kind === "function" && item.funcName === "u22_audit_product",
      );
      assert.ok(
        auditRoutine,
        "The indexed trigger function should be present in the Workbench tree",
      );

      const triggerCalls = (await api.treeProvider.getChildren(trigger)).find(
        (item): item is WorkbenchRelationGroupItem =>
          item.kind === "relationGroup" &&
          item.group.relation === "calls" &&
          item.group.direction === "outgoing",
      );
      assert.ok(triggerCalls, "The trigger should call its indexed trigger function");
      assert.ok(
        triggerCalls.group.targets.some(
          (target) =>
            target.object?.kind === "function" && target.object.name === "u22_audit_product",
        ),
      );

      const routineCallers = (await api.treeProvider.getChildren(auditRoutine)).find(
        (item): item is WorkbenchRelationGroupItem =>
          item.kind === "relationGroup" &&
          item.group.relation === "calls" &&
          item.group.direction === "incoming",
      );
      assert.ok(routineCallers, "The trigger function should expose its incoming trigger caller");
      assert.ok(
        routineCallers.group.targets.some(
          (target) =>
            target.object?.kind === "trigger" && target.object.name === "u22_product_audit",
        ),
      );
      const tableChildren = await api.treeProvider.getChildren(table);
      const tableColumns = tableChildren.filter(
        (item): item is WorkbenchTableMemberItem =>
          item.kind === "tableMember" && item.member.kind === "column",
      );
      assert.deepStrictEqual(
        tableColumns.map((item) => item.member.name),
        ["id", "name"],
        "The source tree should expose every indexed table column in declaration order",
      );
      assert.ok(
        tableColumns.every((item) => item.member.type.length > 0),
        "Every table column should expose the SQL type supplied by Code Moniker",
      );

      const order = graphObjects.find(
        (item): item is WorkbenchObjectItem =>
          item.kind === "object" &&
          item.object.kind === "table" &&
          item.object.name === "u22_order_source",
      );
      assert.ok(order, "The referencing table should be present in the Workbench tree");
      const orderChildren = await api.treeProvider.getChildren(order);
      const references = orderChildren.find(
        (item): item is WorkbenchRelationGroupItem =>
          item.kind === "relationGroup" &&
          item.group.relation === "references" &&
          item.group.direction === "outgoing",
      );
      const relationEvidence = await api.workbenchIndex.relations(order.object, result!);
      assert.ok(
        references,
        `A foreign key should expose its outgoing table relation: ${JSON.stringify(relationEvidence)}`,
      );
      const referenceTargets = await api.treeProvider.getChildren(references);
      assert.deepStrictEqual(
        referenceTargets.map((item) => item.label),
        ["u22_graph.u22_product_source"],
        "Table and referenced-column facts must render as one semantic table target",
      );
      const referenceTarget = referenceTargets[0];
      assert.ok(referenceTarget?.kind === "relationTarget");
      assert.deepStrictEqual(
        referenceTarget.target.members.map((member) => member.name),
        ["id"],
        "The merged relation should retain its referenced-column detail",
      );

      const databaseGraphOpened = await vscode.commands.executeCommand<boolean>(
        "postgresql-workbench.openDatabaseGraph",
      );
      assert.strictEqual(
        databaseGraphOpened,
        true,
        "The Sources header should open the active indexed database graph",
      );
      assert.strictEqual(api.workbenchGraph.visible, true);
      const databaseScope = api.workbenchGraph.currentScope;
      const databaseRenderId = api.workbenchGraph.currentRenderId;
      assert.ok(databaseScope, "The database graph should resolve an identity scope");
      assert.ok(databaseRenderId);
      assert.deepStrictEqual(
        api.workbenchGraph.currentBreadcrumbs.map((step) => step.label),
        ["testdb"],
        "The database entry point should start at the semantic database scope",
      );
      const renderedLanding = await waitForRenderedGraph(api, databaseScope, databaseRenderId);
      assert.deepStrictEqual(
        renderedLanding.cards,
        [],
        "The database entry point should be a search-first cockpit, not a global hairball",
      );
      assert.match(
        renderedLanding.search?.placeholder ?? "",
        /search an object/i,
        "The cockpit should expose its indexed PostgreSQL search in the rendered webview",
      );

      const groups = await api.treeProvider.getChildren(view);
      const reads = groups.find(
        (item): item is WorkbenchRelationGroupItem =>
          item.kind === "relationGroup" &&
          item.group.relation === "reads" &&
          item.group.direction === "outgoing",
      );
      const viewRelationEvidence = await api.workbenchIndex.relations(view.object, result!);
      assert.ok(
        reads,
        `The focused view should expose its direct reads relation: ${JSON.stringify(viewRelationEvidence)}`,
      );
      const targets = await api.treeProvider.getChildren(reads);
      const product = targets.find(
        (item): item is WorkbenchRelationTargetItem =>
          item.kind === "relationTarget" &&
          item.target.object?.kind === "table" &&
          item.target.object.schema === "u22_graph" &&
          item.target.object.name === "u22_product_source",
      );
      assert.ok(product, "The related table should remain a navigable PostgreSQL object");
      assert.strictEqual(
        product.command?.command,
        undefined,
        "Selecting a relation target must stay neutral; navigation uses its explicit action",
      );

      const graphOpened = await vscode.commands.executeCommand<boolean>(
        "postgresql-workbench.openObjectGraph",
        view,
      );
      assert.strictEqual(graphOpened, true, "The indexed view should open a focused graph panel");
      assert.strictEqual(api.workbenchGraph.visible, true);
      const graph = api.workbenchGraph.currentModel;
      const focusedRenderId = api.workbenchGraph.currentRenderId;
      assert.ok(graph?.prefix, "The graph should resolve the selected object to an identity scope");
      assert.ok(focusedRenderId);
      assert.ok((graph?.nodes.length ?? 0) > 0, "The identity scope should expose navigable nodes");
      await waitForGraphAck(api, graph!.prefix, focusedRenderId);
      assert.deepStrictEqual(
        api.workbenchGraph.currentBreadcrumbs.map((step) => step.label),
        ["testdb", "u22_graph", "u22_product_view"],
        "The graph breadcrumb should expose the database, schema, and selected object without technical kind scopes",
      );
      const nodeLabels = graph!.nodes.map(
        (node) => api.workbenchGraph.currentPresentations[node.identity]?.label,
      );
      assert.ok(
        nodeLabels.includes("u22_product_view"),
        `The graph should promote the PostgreSQL view instead of its OID module: ${nodeLabels.join(", ")}`,
      );
      const renderedFocus = await waitForRenderedGraph(api, graph!.prefix, focusedRenderId);
      assert.ok(
        renderedFocus.cards.some(
          (card) =>
            card.label === "u22_product_view" && card.kind === "view" && card.role === "focus",
        ),
        `The DOM should contain the PostgreSQL view card: ${JSON.stringify(renderedFocus.cards)}`,
      );
      assert.ok(
        renderedFocus.cards.length <= 7,
        `The initial cockpit must stay bounded to focus plus top-3 in each direction: ${JSON.stringify(renderedFocus.cards)}`,
      );
      assert.ok(
        renderedFocus.cards.every(
          (card) => card.kind !== "module" && !Number.isInteger(Number(card.label)),
        ),
        `No rendered card may expose a module or OID identity: ${JSON.stringify(renderedFocus.cards)}`,
      );
      assert.ok(
        renderedFocus.cards.some(
          (card) => card.label === "u22_product_source" && card.kind === "table",
        ),
        `The focused SQL graph should render the related table as a card: ${JSON.stringify(renderedFocus.cards)}`,
      );
      const focusedReads = renderedFocus.edges.find(
        (edge) =>
          edge.sourceLabel === "u22_product_view" &&
          edge.targetLabel === "u22_product_source" &&
          edge.kinds.includes("reads"),
      );
      assert.ok(
        focusedReads,
        `The focused SQL graph should directly connect the view to its table: ${JSON.stringify(renderedFocus.edges)}`,
      );
      assert.strictEqual(
        renderedFocus.preview,
        undefined,
        "Opening a focused graph must keep the explicit Source panel closed",
      );

      const schemaScope = api.workbenchGraph.currentBreadcrumbs.find(
        (step) => step.label === "u22_graph",
      );
      assert.ok(schemaScope, "The graph should expose its PostgreSQL schema scope");
      assert.strictEqual(await api.workbenchGraph.focusNode(schemaScope.prefix), true);
      const schemaPrefix = api.workbenchGraph.currentScope;
      const schemaRenderId = api.workbenchGraph.currentRenderId;
      assert.ok(schemaPrefix);
      assert.ok(schemaRenderId);
      const renderedSchema = await waitForRenderedGraph(api, schemaPrefix, schemaRenderId);
      assert.deepStrictEqual(
        renderedSchema.cards,
        [],
        `A schema entry point must remain search-first instead of rendering a global graph: ${JSON.stringify(renderedSchema.cards)}`,
      );
      assert.deepStrictEqual(
        renderedSchema.edges,
        [],
        `A schema entry point must not build all schema relations: ${JSON.stringify(renderedSchema.edges)}`,
      );
      assert.match(
        renderedSchema.search?.placeholder ?? "",
        /search an object/i,
        "The schema landing should keep search as the cockpit entry point",
      );
      productNodeId = product.target.symbol.uri;
      assert.ok(
        graph?.edges.some(
          (edge) =>
            edge.kinds.includes("reads") &&
            edge.source === view.object.symbolUri &&
            edge.target === productNodeId,
        ),
        "The identity graph should preserve the Code Moniker reads relation",
      );
      assert.strictEqual(
        await api.workbenchGraph.syncObjectFromTree(product.target.object!, result),
        true,
        "Selecting a related SQL object in Sources should refocus the existing graph cockpit",
      );
      assert.notStrictEqual(api.workbenchGraph.currentScope, graph?.prefix);
      assert.strictEqual(
        api.workbenchGraph.historyDepth >= 2,
        true,
        "The history should retain the focused object, schema landing, and related table",
      );
      assert.strictEqual(await api.workbenchGraph.back(), true);
      assert.strictEqual(
        await api.workbenchGraph.openNodeDefinition(productNodeId),
        true,
        "A graph node should open its revision-bound SQL definition",
      );
      assert.match(
        vscode.window.activeTextEditor?.document.getText() ?? "",
        /CREATE TABLE "u22_graph"\."u22_product_source"/i,
      );
    } finally {
      await client!.query("DROP SCHEMA IF EXISTS u22_graph CASCADE");
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
    }
    assert.ok(productNodeId);
    assert.strictEqual(
      await api.workbenchGraph.openNodeDefinition(productNodeId!),
      false,
      "The graph must report a rejected definition after its snapshot becomes stale",
    );
  });

  test("rejects a concurrent external launch before PostgreSQL backends are created", async () => {
    const firstStarted = waitForSessionStart(20_000);
    const firstAccepted = await vscode.debug.startDebugging(
      undefined,
      pgConfig("SELECT test_simple(1, 'first external')", "First external debug"),
    );
    assert.strictEqual(firstAccepted, true);
    const firstSession = await firstStarted;

    const deadline = Date.now() + 15_000;
    while (api.debugSessions.active?.state !== "suspended" && Date.now() < deadline) {
      await delay(50);
    }
    assert.strictEqual(api.debugSessions.active?.state, "suspended");

    const client = api.connectionManager.getClient();
    assert.ok(client, "The extension connection should be available");
    const countBackends = async () => {
      const result = await client!.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE application_name LIKE 'plpgsql_dap_listener_%'
           OR application_name LIKE 'plpgsql_dap_target_%'
      `);
      return result.rows[0]?.count ?? 0;
    };
    const firstBackendCount = await countBackends();
    assert.strictEqual(firstBackendCount, 2);

    const secondAccepted = await vscode.debug.startDebugging(
      undefined,
      pgConfig("SELECT test_simple(2, 'second external')", "Second external debug"),
    );
    assert.strictEqual(secondAccepted, false);
    await delay(300);
    assert.strictEqual(await countBackends(), firstBackendCount);
    assert.strictEqual(api.debugSessions.active?.vscodeSessionId, firstSession.id);

    const threads = await firstSession.customRequest("threads");
    const ended = waitSessionEnd();
    await firstSession.customRequest("continue", { threadId: threads.threads[0].id });
    await ended;
  });

  test("openFunction opens the canonical Code Moniker document", async () => {
    const funcs = await publicFunctions(api);
    const target = funcs.find((f) => f.funcName === "test_simple")!;

    await vscode.commands.executeCommand("postgresql-workbench.openFunction", target);

    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, "openFunction should show an editor");
    assert.strictEqual(
      doc!.uri.toString(),
      api.workbenchIndex.documentUri(target.symbolUri)?.toString(),
    );
    assert.strictEqual(api.workbenchIndex.sourceDescriptor(target.symbolUri)?.serverId, SERVER_ID);
    assert.strictEqual(doc!.languageId, "plpgsql");
    assert.ok(doc!.getText().includes("CREATE OR REPLACE FUNCTION"), "Doc should hold the source");
  });

  test("debugFromTree launches a session for a zero-arg routine", async () => {
    const funcs = await publicFunctions(api);
    const target = funcs.find((f) => f.funcName === "test_record_var")!;
    assert.ok(target, "test_record_var should be in the tree");

    const sessionStarted = waitForSessionStart(20_000);
    try {
      await vscode.commands.executeCommand("postgresql-workbench.debugFromTree", target);
      const session = await sessionStarted;
      await delay(5000);

      const stack = await session.customRequest("stackTrace", {
        threadId: (await session.customRequest("threads")).threads[0].id,
      });
      assert.ok(
        stack.stackFrames[0]?.name.includes("test_record_var"),
        `Expected test_record_var frame, got ${stack.stackFrames[0]?.name}`,
      );
      assert.strictEqual(
        stack.stackFrames[0].source.path,
        api.workbenchIndex.documentUri(target.symbolUri)?.toString(),
      );
    } finally {
      await stopActivePlpgsqlSession();
    }
  });

  test("demo callsite assigns a connection, reveals Debug, and runs end to end", async () => {
    await resetShopFixture(api);
    const extensionUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
    const callsite = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(extensionUri, "..", "demo", "debug-me.sql"),
    );
    await vscode.window.showTextDocument(callsite, { preview: true });
    await api.callSiteConnections.clearAll();
    const unassignedLenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        callsite.uri,
      )) ?? [];
    const assignment = unassignedLenses.find(
      (lens) =>
        lens.command?.command === "postgresql-workbench.assignCallConnection" &&
        lens.command.arguments?.[0]?.sql === "SELECT shop.restock_report(10)",
    );
    assert.ok(
      assignment,
      `Unassigned demo callsite should ask for a PostgreSQL connection; got ${unassignedLenses
        .map((lens) => `${lens.command?.command}:${lens.command?.arguments?.[0]?.sql ?? ""}`)
        .join(", ")}`,
    );
    assert.ok(
      !unassignedLenses.some(
        (lens) =>
          lens.command?.command === "postgresql-workbench.debugCall" &&
          lens.command.arguments?.[0]?.sql === "SELECT shop.restock_report(10)",
      ),
      "Debug should not appear before the callsite connection is assigned",
    );

    await vscode.commands.executeCommand(
      "postgresql-workbench.assignCallConnection",
      assignment!.command!.arguments![0],
      SERVER_ID,
    );
    const assignedLenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        callsite.uri,
      )) ?? [];
    const debugLens = assignedLenses.find(
      (lens) =>
        lens.command?.command === "postgresql-workbench.debugCall" &&
        lens.command.arguments?.[0]?.sql === "SELECT shop.restock_report(10)",
    );
    assert.ok(debugLens, "Debug should appear after assigning the callsite connection");
    assert.ok(
      debugLens!.command?.arguments?.[0]?.serverId === SERVER_ID,
      "Debug should pin the connection assigned to this callsite",
    );
    assert.ok(
      assignedLenses.some(
        (lens) =>
          lens.command?.command === "postgresql-workbench.assignCallConnection" &&
          lens.command.title === "$(database) postgres@localhost:5433/testdb",
      ),
      "The assigned connection should remain visible and selectable",
    );
    api.resultStore.clear();
    const sessionStarted = waitForSessionStart(20_000);

    await vscode.commands.executeCommand(
      debugLens!.command!.command,
      ...(debugLens!.command!.arguments ?? []),
    );
    const session = await sessionStarted;
    const stopped = await waitForRoutineFrame(session, "restock_report");
    const stoppedUri = vscode.Uri.parse(stopped.source);
    assert.ok(
      stoppedUri.scheme === "code+moniker" || isPostgresqlDapDocument(stoppedUri),
      `The stopped routine must use a supported Workbench source, got ${stopped.source}`,
    );
    assert.ok(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === callsite.uri.toString(),
        ),
      "The call-site tab should remain open when the stopped routine source is revealed",
    );

    const ended = waitSessionEnd();
    await session.customRequest("continue", { threadId: stopped.threadId });
    await ended;
    for (let attempt = 0; attempt < 20 && !api.resultsViewVisible(); attempt++) {
      await delay(100);
    }
    assert.ok(
      api.resultsViewVisible(),
      "Continue should reveal the PL/pgSQL Results view instead of the view command palette",
    );
    assert.strictEqual(api.resultStore.selected?.rowCount, 1);
    const result = api.resultStore.selected?.rows[0]?.[0];
    assert.strictEqual(result?.kind, "json");
    const report = JSON.parse(result?.value ?? "null") as Array<{ product: string }>;
    assert.deepStrictEqual(report.map((item) => item.product).sort(), [
      "Magret séché",
      "Truite fumée",
    ]);
    assert.match(api.resultStore.selected?.label ?? "", /debug-me\.sql/);
    assert.strictEqual(
      await vscode.commands.executeCommand("postgresql-workbench.results.copy"),
      true,
    );
    const copied = await vscode.env.clipboard.readText();
    assert.match(copied, /^restock_report\n"/);
    assert.match(copied, /Truite fumée/);
  });

  test("three successive demo callsites publish DAP frames, results, and terminate", async () => {
    await resetShopFixture(api);
    const extensionUri = vscode.extensions.getExtension(EXT_ID)!.extensionUri;
    const callsite = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(extensionUri, "..", "demo", "debug-me.sql"),
    );
    const readme = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(extensionUri, "..", "README.md"),
    );
    await vscode.window.showTextDocument(readme, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
    });
    await vscode.window.showTextDocument(callsite, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await api.callSiteConnections.clearAll();

    const assignments =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        callsite.uri,
      )) ?? [];
    const calls = [
      { sql: "SELECT shop.restock_report(10)", routine: "restock_report" },
      { sql: "SELECT shop.place_order(1, 1, 2)", routine: "place_order" },
      { sql: "CALL shop.try_order(2, 3, 1)", routine: "try_order" },
    ];
    for (const { sql } of calls) {
      const assignment = assignments.find(
        (lens) =>
          lens.command?.command === "postgresql-workbench.assignCallConnection" &&
          lens.command.arguments?.[0]?.sql === sql,
      );
      assert.ok(assignment, `Missing connection assignment lens for ${sql}`);
      await vscode.commands.executeCommand(
        "postgresql-workbench.assignCallConnection",
        assignment!.command!.arguments![0],
        SERVER_ID,
      );
    }

    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        callsite.uri,
      )) ?? [];
    const debugLens = (sql: string) => {
      const lens = lenses.find(
        (candidate) =>
          candidate.command?.command === "postgresql-workbench.debugCall" &&
          candidate.command.arguments?.[0]?.sql === sql,
      );
      assert.ok(lens, `Missing Debug lens for ${sql}`);
      return lens!;
    };

    const firstStarted = waitForSessionStart(20_000);
    const firstLens = debugLens(calls[0].sql);
    await vscode.commands.executeCommand(
      firstLens.command!.command,
      ...(firstLens.command!.arguments ?? []),
    );
    const firstSession = await firstStarted;
    const firstStop = await waitForRoutineFrame(firstSession, "restock_report");
    const firstEnded = waitSessionEnd();
    await firstSession.customRequest("continue", { threadId: firstStop.threadId });
    await firstEnded;
    await waitForSuccessfulResult(api, calls[0].sql);
    assert.strictEqual(currentDebugSession(api), undefined);

    await vscode.commands.executeCommand("workbench.action.closePanel");
    for (let attempt = 0; attempt < 20 && api.resultsViewVisible(); attempt++) {
      await delay(50);
    }
    assert.strictEqual(api.resultsViewVisible(), false, "The Results panel should be closed");
    await vscode.window.showTextDocument(callsite, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const secondStarted = waitForSessionStart(20_000);
    const secondLens = debugLens(calls[1].sql);
    await vscode.commands.executeCommand(
      secondLens.command!.command,
      ...(secondLens.command!.arguments ?? []),
    );
    const secondSession = await secondStarted;
    for (
      let attempt = 0;
      attempt < 40 &&
      !(
        api.resultStore.selectedEntry &&
        "status" in api.resultStore.selectedEntry &&
        api.resultStore.selectedEntry.status === "pending" &&
        api.resultStore.selectedEntry.query.includes("shop.place_order")
      );
      attempt++
    ) {
      await delay(25);
    }
    assert.strictEqual(
      api.resultsViewVisible(),
      false,
      "Starting the second callsite must not reveal Results while VS Code is navigating to its stopped source",
    );
    const secondStop = await waitForRoutineFrame(secondSession, "place_order");
    assert.ok(
      secondStop.elapsedMs < 3_000,
      `Second DAP frame took ${secondStop.elapsedMs}ms to expose its source`,
    );
    assert.ok(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === callsite.uri.toString(),
        ),
      "The demo callsite should remain open across successive sessions",
    );

    const secondEnded = waitSessionEnd();
    await secondSession.customRequest("continue", { threadId: secondStop.threadId });
    await secondEnded;
    await waitForSuccessfulResult(api, calls[1].sql);
    assert.strictEqual(currentDebugSession(api), undefined);

    await vscode.window.showTextDocument(callsite, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const thirdStarted = waitForSessionStart(20_000);
    const thirdLens = debugLens(calls[2].sql);
    await vscode.commands.executeCommand(
      thirdLens.command!.command,
      ...(thirdLens.command!.arguments ?? []),
    );
    const thirdSession = await thirdStarted;
    const thirdStop = await waitForRoutineFrame(thirdSession, calls[2].routine);
    assert.ok(
      thirdStop.elapsedMs < 3_000,
      `Third DAP frame took ${thirdStop.elapsedMs}ms to expose its source`,
    );
    const thirdRuntime = await waitForDebugSessionState(api, "suspended");
    assert.strictEqual(thirdRuntime?.status?.routine?.name, "try_order");
    assert.ok((thirdRuntime?.status?.routine?.oid ?? 0) > 0);
    assert.ok((thirdRuntime?.status?.listenerPid ?? 0) > 0);
    assert.ok((thirdRuntime?.status?.targetPid ?? 0) > 0);
    api.connectionTreeProvider.refresh();
    const serverChildren = await connectionChildren(api);
    const liveSessionItem = serverChildren.find(
      (item): item is DebugSessionsItem => item.kind === "debugSessions",
    );
    assert.match(
      String(liveSessionItem?.description ?? ""),
      /shop\.try_order · suspended/,
      "The connection view should expose the live routine and adapter state",
    );
    assert.match(String(liveSessionItem?.tooltip ?? ""), /OID \d+/);
    assert.match(String(liveSessionItem?.tooltip ?? ""), /listener PID \d+/);
    assert.match(String(liveSessionItem?.tooltip ?? ""), /target PID \d+/);

    const thirdEnded = waitSessionEnd();
    await thirdSession.customRequest("continue", { threadId: thirdStop.threadId });
    await thirdEnded;
    const callResult = await waitForSuccessfulResult(api, calls[2].sql);
    assert.strictEqual(callResult.command, "CALL");
    assert.strictEqual(callResult.rowCount, 1);
    assert.strictEqual(callResult.columns[0]?.name, "status");
    assert.match(callResult.rows[0]?.[0]?.value ?? "", /^REFUSED:/);
    assert.strictEqual(currentDebugSession(api), undefined);
  });

  test("debug-session recovery lists and terminates only selected DAP backends", async () => {
    const sessionId = `recovery${Date.now()}`;
    const orphanSessionId = `${sessionId}orphan`;
    const vanishedSessionId = `${sessionId}vanished`;
    const config = {
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      password: "postgres",
    };
    const connectionClient = api.connectionManager.getClient();
    assert.ok(connectionClient, "The extension connection should be available");
    const routineResult = await connectionClient!.query<{ oid: string }>(
      "SELECT 'public.test_simple(integer,text)'::regprocedure::oid::text AS oid",
    );
    const routineOid = Number(routineResult.rows[0]?.oid);
    const listener = new Client({
      ...config,
      application_name: debugApplicationName("listener", sessionId, routineOid),
    });
    const target = new Client({
      ...config,
      application_name: debugApplicationName("target", sessionId, routineOid),
    });
    const orphanListener = new Client({
      ...config,
      application_name: debugApplicationName("listener", orphanSessionId),
    });
    const vanishedListener = new Client({
      ...config,
      application_name: debugApplicationName("listener", vanishedSessionId),
    });
    const replacementListener = new Client({
      ...config,
      application_name: debugApplicationName("listener", vanishedSessionId),
    });
    const protectedClient = new Client({
      ...config,
      application_name: `plpgsql_dap_listenerish_${sessionId}`,
    });
    listener.on("error", () => {});
    target.on("error", () => {});
    orphanListener.on("error", () => {});
    vanishedListener.on("error", () => {});
    replacementListener.on("error", () => {});
    protectedClient.on("error", () => {});

    try {
      await Promise.all([
        listener.connect(),
        target.connect(),
        orphanListener.connect(),
        vanishedListener.connect(),
        protectedClient.connect(),
      ]);

      const sessions = await listDebugSessions(connectionClient!);
      const recoverySession = sessions.find((session) => session.id === sessionId);
      assert.ok(recoverySession, "The logical DAP session should be listed");
      assert.deepStrictEqual(
        recoverySession!.routine,
        {
          oid: routineOid,
          schema: "public",
          name: "test_simple",
          kind: "function",
        },
        "A stale session should recover its exact routine without adapter state",
      );
      assert.strictEqual(recoverySession!.stateSource, "database");
      assert.deepStrictEqual(recoverySession!.backends.map((backend) => backend.role).sort(), [
        "listener",
        "target",
      ]);
      assert.ok(
        recoverySession!.backends.every((backend) => backend.routineOid === routineOid),
        "Every encoded backend should expose the recovered routine OID",
      );
      const orphanSession = sessions.find((session) => session.id === orphanSessionId);
      assert.deepStrictEqual(
        orphanSession?.backends.map((backend) => backend.role),
        ["listener"],
        "An incomplete stale session should remain recoverable",
      );
      assert.ok(
        sessions.some((session) => session.id === vanishedSessionId),
        "The soon-to-vanish session should be listed before selection",
      );
      const selectedSessions = sessions.filter((session) =>
        [sessionId, orphanSessionId, vanishedSessionId].includes(session.id),
      );
      assert.ok(
        !sessions.some((session) => session.id === `ish_${sessionId}`),
        "A similar non-DAP application name must not be listed",
      );

      api.connectionTreeProvider.refresh();
      const children = await connectionChildren(api);
      const recoveryItem = children.find(
        (item): item is DebugSessionsItem => item.kind === "debugSessions",
      );
      assert.ok(recoveryItem, "The connection view should expose debug-session recovery");
      assert.ok(
        typeof recoveryItem!.count === "number" && recoveryItem!.count >= 3,
        "The connection view should show the session count",
      );
      assert.strictEqual(
        recoveryItem!.command?.command,
        "postgresql-workbench.manageDebugSessions",
      );

      await vanishedListener.end();
      await replacementListener.connect();
      const terminations = await terminateDebugSessions(
        connectionClient!,
        debugBackendSelections(selectedSessions),
      );
      assert.strictEqual(
        terminations.length,
        4,
        "Every backend displayed to the user should have an explicit outcome",
      );
      assert.strictEqual(
        terminations.filter((termination) => termination.status === "terminated").length,
        3,
        "The complete session and orphan listener should terminate",
      );
      assert.strictEqual(
        terminations.filter((termination) => termination.status === "alreadyGone").length,
        1,
        "The backend that ended during selection should be reported",
      );
      assert.strictEqual(
        (await replacementListener.query("SELECT 1")).rowCount,
        1,
        "A replacement backend that was never displayed must survive",
      );

      const control = await protectedClient.query<{ value: number }>("SELECT 1 AS value");
      assert.strictEqual(control.rows[0]?.value, 1, "The non-DAP backend must survive");
      assert.ok(
        !(await listDebugSessions(connectionClient!)).some((session) =>
          [sessionId, orphanSessionId].includes(session.id),
        ),
        "The selected DAP backends should disappear",
      );
    } finally {
      await Promise.all([
        listener.end().catch(() => {}),
        target.end().catch(() => {}),
        orphanListener.end().catch(() => {}),
        vanishedListener.end().catch(() => {}),
        replacementListener.end().catch(() => {}),
        protectedClient.end().catch(() => {}),
      ]);
    }
  });

  test("debug-session recovery reports permission denial without killing another role", async () => {
    const admin = api.connectionManager.getClient();
    assert.ok(admin, "The extension connection should be available");
    const role = "dap_recovery_limited";
    const sessionId = `foreign${Date.now()}`;
    const foreignListener = new Client({
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      password: "postgres",
      application_name: debugApplicationName("listener", sessionId),
    });
    let limited: Client | undefined;
    foreignListener.on("error", () => {});

    try {
      await admin!.query(`DROP ROLE IF EXISTS ${role}`);
      await admin!.query(`CREATE ROLE ${role} LOGIN PASSWORD 'recovery'`);
      limited = new Client({
        host: "localhost",
        port: 5433,
        database: "testdb",
        user: role,
        password: "recovery",
      });
      limited.on("error", () => {});
      await Promise.all([foreignListener.connect(), limited.connect()]);

      const visible = (await listDebugSessions(limited)).find(
        (session) => session.id === sessionId,
      );
      assert.ok(visible, "The foreign DAP session should be visible for recovery diagnostics");
      assert.strictEqual(
        visible!.backends[0]?.ownedByCurrentUser,
        false,
        "The foreign PostgreSQL role should be identified",
      );

      const terminations = await terminateDebugSessions(
        limited,
        debugBackendSelections([visible!]),
      );
      assert.strictEqual(
        terminations.find((result) => result.role === "listener")?.status,
        "denied",
      );
      assert.strictEqual(terminations.length, 1);
      assert.strictEqual((await foreignListener.query("SELECT 1")).rowCount, 1);
    } finally {
      await limited?.end().catch(() => {});
      await foreignListener.end().catch(() => {});
      await admin?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
  });

  test("disconnectServer command disconnects", async () => {
    await vscode.commands.executeCommand("postgresql-workbench.disconnectServer");
    assert.strictEqual(api.connectionManager.isConnected, false);
    const deadline = Date.now() + 10_000;
    while (api.workbenchIndex.state.status !== "not-indexed" && Date.now() < deadline) {
      await delay(50);
    }
    assert.strictEqual(
      api.workbenchIndex.state.status,
      "not-indexed",
      "Disconnecting should remove the published source set before returning to not indexed",
    );
  });
});
