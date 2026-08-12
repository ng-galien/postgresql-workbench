import * as assert from "node:assert";
import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import type { PlpgsqlExtensionApi } from "../extension.js";
import { NEW_SQL_NOTEBOOK_COMMAND, RECONNECT_SQL_NOTEBOOK_COMMAND } from "../sqlNotebook.js";
import { SQL_NOTEBOOK_SCHEME } from "../sqlNotebookFileSystem.js";
import {
  SQL_NOTEBOOK_RESULT_MIME,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookResultPayload,
} from "../sqlNotebookModel.js";
import { OPEN_SQL_NOTEBOOK_COMMAND, RENAME_SQL_NOTEBOOK_COMMAND } from "../sqlNotebookWorkspace.js";
import { PostgresCursorReader, SqlResultSession } from "../sqlResultSession.js";
import { delay, EXT_ID, pgAvailable } from "./testUtils.js";

const SERVER_ID = "sql-notebook:localhost:5433/testdb:postgres";
const SECONDARY_SERVER_ID = "sql-notebook-secondary:localhost:5433/testdb:postgres";
const TEST_BINDING = {
  serverId: SERVER_ID,
  serverName: "Notebook integration PostgreSQL",
  database: "testdb",
};

suite("SQL notebook integration", function () {
  this.timeout(30_000);
  let api: PlpgsqlExtensionApi;
  const notebookUris: vscode.Uri[] = [];

  const createNotebook = async () => {
    const uri = await vscode.commands.executeCommand<vscode.Uri>(
      NEW_SQL_NOTEBOOK_COMMAND,
      SERVER_ID,
    );
    assert.ok(uri);
    notebookUris.push(uri);
    const notebook = vscode.workspace.notebookDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    assert.ok(notebook);
    return notebook;
  };

  const scratchpadsNode = async () => {
    const root = await api.treeProvider.getChildren();
    const server = root.find((item) => item.kind === "server" && item.server.id === SERVER_ID);
    assert.ok(server);
    const database = (await api.treeProvider.getChildren(server)).find(
      (item) => item.kind === "databaseSource",
    );
    assert.ok(database);
    const scratchpads = (await api.treeProvider.getChildren(database)).find(
      (item) => item.kind === "scratchpads",
    );
    assert.ok(scratchpads);
    return scratchpads;
  };

  const scratchpadItems = async () => api.treeProvider.getChildren(await scratchpadsNode());

  suiteSetup(async function () {
    if (!(await pgAvailable())) this.skip();
    const extension = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXT_ID);
    assert.ok(extension);
    api = await extension.activate();
    await api.connectionManager.store.add(
      {
        id: SERVER_ID,
        name: "Notebook integration PostgreSQL",
        host: "localhost",
        port: 5433,
        database: "testdb",
        user: "postgres",
      },
      "postgres",
    );
    assert.strictEqual(
      await vscode.commands.executeCommand("postgresql-workbench.connectServer", SERVER_ID),
      true,
    );
  });

  suiteTeardown(async () => {
    for (const uri of notebookUris) {
      await vscode.workspace.fs.delete(uri).then(undefined, () => {});
    }
    if (api) await api.connectionManager.store.remove(SERVER_ID).catch(() => {});
    if (api) await api.connectionManager.store.remove(SECONDARY_SERVER_ID).catch(() => {});
  });

  test("persists a scratch notebook and executes one SQL cell into the table payload", async () => {
    const notebook = await createNotebook();
    assert.strictEqual(notebook.notebookType, SQL_NOTEBOOK_TYPE);
    assert.strictEqual(notebook.uri.scheme, SQL_NOTEBOOK_SCHEME);
    assert.strictEqual(notebook.uri.path.split("/").filter(Boolean).length, 1);
    assert.strictEqual(notebook.metadata.serverId, SERVER_ID);
    assert.match(notebook.uri.path, /Scratch \d{3}\.pgsql-notebook$/u);
    assert.strictEqual(notebook.cellAt(0).document.languageId, "plpgsql");

    const payload = await replaceCellAndExecute(
      notebook,
      `SELECT 7::integer AS id, '{"ready": true}'::jsonb AS details`,
    );

    assert.deepStrictEqual(
      payload.columns.map((column) => column.name),
      ["id", "details"],
    );
    assert.strictEqual(payload.rows[0]?.[0]?.kind, "number");
    assert.strictEqual(payload.rows[0]?.[0]?.value, "7");
    assert.strictEqual(payload.rows[0]?.[1]?.kind, "json");
    assert.strictEqual(payload.rowCount, 1);
    assert.strictEqual(payload.truncated, false);
    assert.strictEqual(payload.navigation, undefined);

    const saved = JSON.parse(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(notebook.uri)),
    );
    assert.strictEqual(saved.metadata.serverId, SERVER_ID);
    assert.match(saved.cells[0].source, /SELECT 7/);
    assert.strictEqual(saved.cells[0].outputs, undefined);
  });

  test("uses its binding without switching the active database context", async function () {
    this.timeout(60_000);
    await api.connectionManager.store.add(
      {
        id: SECONDARY_SERVER_ID,
        name: "Secondary notebook binding",
        host: "localhost",
        port: 5433,
        database: "testdb",
        user: "postgres",
      },
      "postgres",
    );
    const uri = await vscode.commands.executeCommand<vscode.Uri>(
      NEW_SQL_NOTEBOOK_COMMAND,
      SECONDARY_SERVER_ID,
    );
    assert.ok(uri);
    notebookUris.push(uri);
    const notebook = vscode.workspace.notebookDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    assert.ok(notebook);

    const payload = await replaceCellAndExecute(notebook, "SELECT current_database() AS database");
    assert.strictEqual(payload.binding.serverId, SECONDARY_SERVER_ID);
    assert.strictEqual(api.connectionManager.activeServer?.id, SERVER_ID);
    assert.strictEqual(
      await vscode.commands.executeCommand(RECONNECT_SQL_NOTEBOOK_COMMAND, notebook),
      true,
    );
    assert.strictEqual(api.connectionManager.activeServer?.id, SERVER_ID);
  });

  test("creates a scratchpad from its real inline TreeView context", async () => {
    const uri = await vscode.commands.executeCommand<vscode.Uri>(
      NEW_SQL_NOTEBOOK_COMMAND,
      await scratchpadsNode(),
    );
    assert.ok(uri);
    notebookUris.push(uri);
    const notebook = vscode.workspace.notebookDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    assert.ok(notebook);
    assert.strictEqual(notebook.metadata.serverId, SERVER_ID);
  });

  test("lists, opens, renames, and deletes a scratchpad from the Workbench model", async () => {
    const notebook = await createNotebook();
    const originalUri = notebook.uri;
    const entry = (await api.sqlNotebooks.list()).find(
      (candidate) => candidate.uri.toString() === originalUri.toString(),
    );
    assert.ok(entry);
    assert.strictEqual(entry.metadata.serverId, SERVER_ID);

    const item = (await scratchpadItems()).find(
      (candidate) =>
        candidate.kind === "sqlNotebook" && candidate.entry.uri.toString() === entry.uri.toString(),
    );
    assert.ok(item);
    assert.strictEqual(item.contextValue, "postgresql-workbench-sql-notebook");
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, "note");
    assert.match(item.accessibilityInformation?.label ?? "", /SQL scratchpad Scratch \d{3}/u);
    assert.match(
      item.accessibilityInformation?.label ?? "",
      /Notebook integration PostgreSQL · testdb/u,
    );
    assert.strictEqual(item.command?.command, OPEN_SQL_NOTEBOOK_COMMAND);

    const headerCreation = vscode.commands.executeCommand<vscode.Uri>(
      NEW_SQL_NOTEBOOK_COMMAND,
      item,
    );
    let headerCreationSettled = false;
    void headerCreation.then(
      () => {
        headerCreationSettled = true;
      },
      () => {
        headerCreationSettled = true;
      },
    );
    await delay(100);
    assert.strictEqual(
      headerCreationSettled,
      false,
      "An unrelated selected TreeItem should leave the header database picker open",
    );
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    assert.strictEqual(await headerCreation, undefined);

    const invalidUri = vscode.Uri.from({
      scheme: SQL_NOTEBOOK_SCHEME,
      path: `/Invalid scratchpad ${Date.now()}.pgsql-notebook`,
    });
    notebookUris.push(invalidUri);
    await vscode.workspace.fs.writeFile(invalidUri, new TextEncoder().encode("not-json"));
    const invalidEntry = await api.sqlNotebooks.entry(invalidUri);
    assert.ok(invalidEntry?.error);
    const unavailable = (await api.treeProvider.getChildren()).find(
      (candidate) => candidate.kind === "unboundScratchpads",
    );
    assert.ok(unavailable);
    const invalidItem = (await api.treeProvider.getChildren(unavailable)).find(
      (candidate) =>
        candidate.kind === "sqlNotebook" &&
        candidate.entry.uri.toString() === invalidEntry.uri.toString(),
    );
    assert.ok(invalidItem);
    assert.strictEqual((invalidItem.iconPath as vscode.ThemeIcon).id, "warning");
    assert.match(invalidItem.accessibilityInformation?.label ?? "", /Invalid SQL scratchpad/u);
    await api.sqlNotebooks.delete(invalidEntry);

    assert.strictEqual(await closeNotebookTabs(originalUri), true);
    const openedUri = await vscode.commands.executeCommand<vscode.Uri>(
      OPEN_SQL_NOTEBOOK_COMMAND,
      item,
    );
    assert.strictEqual(openedUri.toString(), originalUri.toString());
    assert.ok(
      vscode.workspace.notebookDocuments.some(
        (candidate) => candidate.uri.toString() === originalUri.toString(),
      ),
    );

    const requestedName = `Managed scratchpad ${Date.now()}`;
    const expectedRenamedUri = vscode.Uri.from({
      scheme: SQL_NOTEBOOK_SCHEME,
      path: `/${requestedName}.pgsql-notebook`,
    });
    notebookUris.push(expectedRenamedUri);
    const renamedUri = await vscode.commands.executeCommand<vscode.Uri>(
      RENAME_SQL_NOTEBOOK_COMMAND,
      item,
      requestedName,
    );
    assert.ok(renamedUri);
    assert.strictEqual(renamedUri.toString(), expectedRenamedUri.toString());
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(originalUri)));
    assert.ok(
      (await api.sqlNotebooks.list()).some(
        (candidate) => candidate.uri.toString() === renamedUri.toString(),
      ),
    );

    const renamedEntry = await api.sqlNotebooks.entry(renamedUri);
    assert.ok(renamedEntry);
    assert.strictEqual(await closeNotebookTabs(renamedUri), true);
    await api.sqlNotebooks.delete(renamedEntry);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(renamedUri)));
  });

  test("opens a 5000-row series as a cursor-backed first page", async () => {
    const configuredRows = vscode.workspace
      .getConfiguration("postgresql-workbench.results")
      .get<number>("pageSize");
    assert.strictEqual(configuredRows, 200);
    const notebook = await createNotebook();
    const payload = await replaceCellAndExecute(
      notebook,
      "SELECT value FROM generate_series(1, 5000) AS value",
    );

    assert.strictEqual(payload.rowCount, undefined);
    assert.strictEqual(payload.capturedRowCount, configuredRows);
    assert.strictEqual(payload.rows.length, configuredRows);
    assert.strictEqual(payload.rows[0]?.[0]?.value, "1");
    assert.strictEqual(payload.rows.at(-1)?.[0]?.value, "200");
    assert.strictEqual(payload.truncated, false);
    assert.deepStrictEqual(payload.navigation, {
      sessionId: payload.navigation?.sessionId,
      mode: "paged",
      pageIndex: 0,
      pageSize: configuredRows,
      pageStart: 1,
      pageEnd: configuredRows,
      loadedRowCount: configuredRows! + 1,
      cacheStart: 1,
      hasPrevious: false,
      hasNext: true,
      canLoadAll: true,
    });
  });

  test("navigates and loads all through a real PostgreSQL cursor", async () => {
    const navigationClient = await api.connectionManager.createDedicatedClient(SERVER_ID);
    const navigation = await SqlResultSession.open(
      new PostgresCursorReader(
        navigationClient,
        "SELECT value FROM generate_series(1, 1000) AS value",
      ),
      { pageSize: 200, maxCachedRows: 1_000, binding: TEST_BINDING },
    );
    try {
      for (let index = 0; index < 4; index += 1) await navigation.next();
      assert.strictEqual(navigation.snapshot().navigation?.pageStart, 801);
      assert.strictEqual(navigation.snapshot().navigation?.pageEnd, 1_000);
      assert.strictEqual(navigation.snapshot().navigation?.hasNext, false);
      assert.strictEqual(navigation.snapshot().rowCount, 1_000);
    } finally {
      await navigation.close();
    }

    const loadAllClient = await api.connectionManager.createDedicatedClient(SERVER_ID);
    const loadAll = await SqlResultSession.open(
      new PostgresCursorReader(
        loadAllClient,
        "SELECT value FROM generate_series(1, 2000) AS value",
      ),
      { pageSize: 200, maxCachedRows: 1_000, binding: TEST_BINDING },
    );
    try {
      const payload = await loadAll.loadAll();
      assert.strictEqual(payload.navigation?.mode, "all");
      assert.strictEqual(payload.rows.length, 2_000);
      assert.strictEqual(payload.rowCount, 2_000);
      assert.strictEqual(payload.rows.at(-1)?.[0]?.value, "2000");
    } finally {
      await loadAll.close();
    }
  });

  test("keeps a data-modifying CTE on the one-shot result path", async () => {
    const client = api.connectionManager.getClient();
    assert.ok(client);
    await client.query("CREATE TABLE IF NOT EXISTS public.notebook_cursor_safety (id integer)");
    await client.query("TRUNCATE public.notebook_cursor_safety");

    try {
      const notebook = await createNotebook();
      const payload = await replaceCellAndExecute(
        notebook,
        `WITH inserted AS (
          INSERT INTO public.notebook_cursor_safety (id)
          SELECT value FROM generate_series(1, 3) AS value
          RETURNING id
        )
        SELECT id FROM inserted ORDER BY id`,
      );

      assert.strictEqual(payload.navigation, undefined);
      assert.strictEqual(payload.rowCount, 3);
      assert.deepStrictEqual(
        payload.rows.map((row) => row[0]?.value),
        ["1", "2", "3"],
      );
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.notebook_cursor_safety",
      );
      assert.strictEqual(count.rows[0]?.count, "3");
    } finally {
      await client.query("DROP TABLE IF EXISTS public.notebook_cursor_safety");
    }
  });
});

async function replaceCellAndExecute(
  notebook: vscode.NotebookDocument,
  sql: string,
): Promise<SqlNotebookResultPayload> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, 1), [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, "plpgsql"),
    ]),
  ]);
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
  await notebook.save();
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(0, 1)],
    document: notebook.uri,
  });
  const output = await waitForNotebookOutput(notebook.cellAt(0));
  const resultItem = output.items.find((item) => item.mime === SQL_NOTEBOOK_RESULT_MIME);
  assert.ok(resultItem);
  return JSON.parse(new TextDecoder().decode(resultItem.data)) as SqlNotebookResultPayload;
}

async function waitForNotebookOutput(
  cell: vscode.NotebookCell,
  timeoutMs = 10_000,
): Promise<vscode.NotebookCellOutput> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = cell.outputs[0];
    if (output) return output;
    await delay(50);
  }
  throw new Error("The SQL notebook cell did not produce an output");
}

async function closeNotebookTabs(uri: vscode.Uri): Promise<boolean> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === uri.toString(),
    ),
  );
  return tabs.length === 0 || vscode.window.tabGroups.close(tabs, true);
}
