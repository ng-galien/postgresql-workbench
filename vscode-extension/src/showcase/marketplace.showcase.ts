import * as assert from "node:assert";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import * as net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import type { PlpgsqlExtensionApi } from "../extension.js";
import { NEW_SQL_NOTEBOOK_COMMAND } from "../sqlNotebook.js";
import { SQL_NOTEBOOK_RESULT_MIME } from "../sqlNotebookModel.js";
import { delay, EXT_ID, stopActivePlpgsqlSession, waitForSessionStart } from "../test/testUtils.js";
import type { WorkbenchGraphWebviewMessage } from "../workbenchGraph/protocol.js";
import { buildWorkbenchObjects, type WorkbenchObjectModel } from "../workbenchTreeModel.js";

const SCENE = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_SCENE;
const CONTROL_DIR = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_CONTROL_DIR;
const THEME = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_THEME ?? "light";
const SERVER = {
  id: "showcase:localhost:5434/demo:postgres",
  name: "postgres@localhost:5434/demo",
  host: "localhost",
  port: 5434,
  database: "demo",
  user: "postgres",
};

suite("PostgreSQL Workbench Marketplace showcase", function () {
  this.timeout(120_000);
  let api: PlpgsqlExtensionApi;
  const notebooks: vscode.Uri[] = [];

  suiteSetup(async () => {
    assert.ok(SCENE, "POSTGRESQL_WORKBENCH_SHOWCASE_SCENE is required");
    assert.ok(CONTROL_DIR, "POSTGRESQL_WORKBENCH_SHOWCASE_CONTROL_DIR is required");
    assert.ok(await postgresAvailable(), "The PostgreSQL demo is not available on port 5434");
    await forceShowcaseTheme();

    const extension = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXT_ID);
    assert.ok(extension, "PostgreSQL Workbench extension is unavailable");
    api = extension.isActive ? extension.exports : await extension.activate();
    await api.connectionManager.store.add(SERVER, "postgres");
    assert.strictEqual(
      await vscode.commands.executeCommand("postgresql-workbench.connectServer", SERVER.id),
      true,
    );
    assert.ok(
      await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase"),
      "The demo database must be indexed before a scene starts",
    );
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await executeFirstAvailableCommand([
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.closeSecondarySideBar",
    ]);
    await delay(300);
    await executeFirstAvailableCommand([
      "notifications.clearAll",
      "workbench.action.clearAllNotifications",
    ]);
  });

  suiteTeardown(async () => {
    await stopActivePlpgsqlSession();
    for (const uri of notebooks) {
      await vscode.workspace.fs.delete(uri).then(undefined, () => {});
    }
    await api?.connectionManager.disconnect();
    await api?.connectionManager.store.remove(SERVER.id).catch(() => {});
  });

  test("runs the selected feature choreography", async () => {
    switch (SCENE) {
      case "cockpit":
        await cockpitScene(api);
        break;
      case "sql-notebook":
        await notebookScene(notebooks);
        break;
      case "tests-coverage":
        await coverageScene(api);
        break;
      case "debugger":
        await debuggerScene(api);
        break;
      default:
        assert.fail(`Unknown Marketplace showcase scene: ${SCENE}`);
    }
  });
});

async function cockpitScene(api: PlpgsqlExtensionApi): Promise<void> {
  const product = object(api, "shop", "product", "table");
  const availability = object(api, "shop", "product_availability", "view");
  const opened = await api.workbenchGraph.open(product, snapshot(api));
  assert.strictEqual(opened, true);
  await waitForGraph(api, product.symbolUri);

  await record(async () => {
    await delay(650);
    receiveGraphMessage(api, {
      type: "requestNeighborhood",
      requestId: 1,
      symbolUri: product.symbolUri,
      intent: "expand",
      direction: "outgoing",
    });
    await delay(1600);
    receiveGraphMessage(api, {
      type: "requestNeighborhood",
      requestId: 2,
      symbolUri: product.symbolUri,
      intent: "expand",
      direction: "incoming",
    });
    await delay(1700);
    assert.strictEqual(await api.workbenchGraph.focusNode(availability.symbolUri), true);
    await waitForGraph(api, availability.symbolUri);
    await delay(1700);
  });
}

async function notebookScene(notebooks: vscode.Uri[]): Promise<void> {
  const uri = await vscode.commands.executeCommand<vscode.Uri>(NEW_SQL_NOTEBOOK_COMMAND, SERVER.id);
  assert.ok(uri);
  notebooks.push(uri);
  const notebook = vscode.workspace.notebookDocuments.find(
    (candidate) => candidate.uri.toString() === uri.toString(),
  );
  assert.ok(notebook);

  const sql = `SELECT
  product.sku,
  product.name AS product,
  brand.name AS brand,
  warehouse.code AS warehouse,
  inventory.quantity,
  inventory.reserved_quantity AS reserved,
  inventory.quantity - inventory.reserved_quantity AS available
FROM shop.inventory
JOIN shop.product ON product.id = inventory.product_id
JOIN shop.brand ON brand.id = product.brand_id
JOIN shop.warehouse ON warehouse.id = inventory.warehouse_id
ORDER BY available, product.name, warehouse.code;`;
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, 1), [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, "plpgsql"),
    ]),
  ]);
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
  await notebook.save();
  await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: false });

  await record(async () => {
    await delay(700);
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: notebook.uri,
    });
    const output = await waitForNotebookOutput(notebook.cellAt(0));
    assert.ok(output.items.some((item) => item.mime === SQL_NOTEBOOK_RESULT_MIME));
    await delay(2600);
  });
}

async function coverageScene(api: PlpgsqlExtensionApi): Promise<void> {
  const routine = object(api, "shop", "restock_report", "function");
  assert.ok(await api.coverageTests.revealRoutine(SERVER.id, routine.oid));

  await record(async () => {
    await delay(650);
    const completed = waitForCoverage(api);
    await vscode.commands.executeCommand("testing.coverageSelected");
    const coverage = await completed;
    assert.ok(coverage.files.length > 0, "The coverage run must publish at least one file");
    await vscode.commands.executeCommand("testing.openCoverage");
    const uri = api.workbenchIndex.documentUri(routine.symbolUri);
    assert.ok(uri);
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
    await delay(500);
    await vscode.commands.executeCommand("testing.toggleInlineCoverage");
    await delay(3200);
  });
}

async function debuggerScene(api: PlpgsqlExtensionApi): Promise<void> {
  await resetShopDebugData(api);
  const extensionUri = vscode.extensions.getExtension(EXT_ID)?.extensionUri;
  assert.ok(extensionUri);
  const callsite = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(extensionUri, "..", "demo", "debug-me.sql"),
  );
  await vscode.window.showTextDocument(callsite, { preview: false, preserveFocus: false });

  const sessionStarted = waitForSessionStart(20_000);
  assert.strictEqual(
    await vscode.debug.startDebugging(undefined, {
      type: "postgresql-workbench",
      request: "launch",
      name: "Showcase: place_order",
      server: SERVER.id,
      sql: "SELECT shop.place_order(1, 1, 2)",
      stopOnEntry: true,
    }),
    true,
  );
  await sessionStarted;
  await waitForStoppedSource();
  await vscode.commands.executeCommand("workbench.view.debug");

  await record(async () => {
    await delay(700);
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
    await delay(1500);
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
    await delay(1500);
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
    await delay(1700);
  });
}

async function record(choreography: () => Promise<void>): Promise<void> {
  assert.ok(CONTROL_DIR);
  await mkdir(CONTROL_DIR, { recursive: true });
  await writeFile(
    path.join(CONTROL_DIR, "ready.json"),
    `${JSON.stringify({
      scene: SCENE,
      theme: vscode.workspace.getConfiguration("workbench").get("colorTheme"),
      themeKind: colorThemeKind(vscode.window.activeColorTheme.kind),
    })}\n`,
  );
  await waitForControlFile("recording");
  try {
    await choreography();
  } finally {
    await writeFile(path.join(CONTROL_DIR, "done"), "done\n");
  }
  await waitForControlFile("stopped");
}

async function executeFirstAvailableCommand(commandIds: readonly string[]): Promise<void> {
  const available = new Set(await vscode.commands.getCommands(true));
  const command = commandIds.find((candidate) => available.has(candidate));
  if (command) await vscode.commands.executeCommand(command);
}

async function forceShowcaseTheme(): Promise<void> {
  assert.ok(THEME === "light" || THEME === "dark", `Unsupported showcase theme: ${THEME}`);
  const expected =
    THEME === "dark"
      ? { id: "Dark Modern", uiTheme: "vs-dark", kind: vscode.ColorThemeKind.Dark }
      : { id: "Light Modern", uiTheme: "vs", kind: vscode.ColorThemeKind.Light };
  const extension = vscode.extensions.getExtension("vscode.theme-defaults");
  assert.ok(extension, "The built-in VS Code theme extension is unavailable");
  const themes = extension.packageJSON?.contributes?.themes as
    | Array<{ id: string; uiTheme: string }>
    | undefined;
  const selectedTheme = themes?.find(
    (theme) => theme.id === expected.id && theme.uiTheme === expected.uiTheme,
  );
  assert.ok(selectedTheme, `VS Code does not expose the expected ${expected.id} theme`);
  await vscode.workspace
    .getConfiguration("workbench")
    .update("colorTheme", expected.id, vscode.ConfigurationTarget.Global);
  await vscode.workspace
    .getConfiguration("window")
    .update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
  const selected = await vscode.commands.executeCommand<string>(
    "workbench.action.previewColorTheme",
    {
      publisher: extension.packageJSON.publisher,
      name: extension.packageJSON.name,
      version: extension.packageJSON.version,
    },
    selectedTheme.id,
  );
  assert.strictEqual(selected, selectedTheme.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (vscode.window.activeColorTheme.kind === expected.kind) return;
    await delay(50);
  }
  assert.fail(
    `VS Code kept ${colorThemeKind(vscode.window.activeColorTheme.kind)} instead of ${THEME}`,
  );
}

function colorThemeKind(kind: vscode.ColorThemeKind): string {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.Dark:
      return "dark";
    case vscode.ColorThemeKind.HighContrast:
      return "high-contrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "high-contrast-light";
  }
}

function waitForCoverage(api: PlpgsqlExtensionApi, timeoutMs = 30_000) {
  return new Promise<{ files: readonly vscode.FileCoverage[] }>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for native pgTAP coverage"));
    }, timeoutMs);
    const subscription = api.coverageTests.coverageProfile.onDidComplete((snapshot) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(snapshot);
    });
  });
}

function object(
  api: PlpgsqlExtensionApi,
  schema: string,
  name: string,
  kind: WorkbenchObjectModel["kind"],
): WorkbenchObjectModel {
  const database = { serverId: SERVER.id, database: SERVER.database };
  const target = buildWorkbenchObjects(api.workbenchIndex.indexedSymbols, database).find(
    (candidate) =>
      candidate.schema === schema && candidate.name === name && candidate.kind === kind,
  );
  assert.ok(target, `Missing indexed ${kind} ${schema}.${name}`);
  return target;
}

function snapshot(api: PlpgsqlExtensionApi) {
  const result = api.workbenchIndex.state.result;
  assert.ok(result);
  return { revision: result.revision, generation: result.generation };
}

function receiveGraphMessage(
  api: PlpgsqlExtensionApi,
  message: WorkbenchGraphWebviewMessage,
): void {
  const graph = api.workbenchGraph as unknown as {
    receive(message: WorkbenchGraphWebviewMessage): void;
  };
  graph.receive(message);
}

async function waitForGraph(
  api: PlpgsqlExtensionApi,
  identity: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      api.workbenchGraph.currentScope === identity &&
      api.workbenchGraph.webviewAcks.some((ack) => ack.prefix === identity)
    ) {
      return;
    }
    await delay(50);
  }
  assert.fail(`Cockpit did not render ${identity}`);
}

async function waitForNotebookOutput(
  cell: vscode.NotebookCell,
  timeoutMs = 10_000,
): Promise<vscode.NotebookCellOutput> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = cell.outputs[0];
    if (output) {
      const result = output.items.find((item) => item.mime === SQL_NOTEBOOK_RESULT_MIME);
      if (result) {
        JSON.parse(new TextDecoder().decode(result.data));
        return output;
      }
    }
    await delay(50);
  }
  assert.fail("The SQL notebook did not produce its result grid");
}

async function waitForStoppedSource(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      vscode.debug.activeDebugSession?.type === "postgresql-workbench" &&
      vscode.window.activeTextEditor?.document.uri.scheme === "code+moniker"
    ) {
      return;
    }
    await delay(100);
  }
  assert.fail("The debugger did not reveal a stopped PL/pgSQL source");
}

async function resetShopDebugData(api: PlpgsqlExtensionApi): Promise<void> {
  const client = api.connectionManager.getClient();
  assert.ok(client);
  await client.query(`
    TRUNCATE shop.order_line, shop.stock_movement RESTART IDENTITY;
    UPDATE shop.product
    SET stock = CASE id WHEN 1 THEN 12 WHEN 2 THEN 8 WHEN 3 THEN 0 WHEN 4 THEN 42 ELSE stock END;
    UPDATE shop.customer
    SET loyalty_points = CASE id WHEN 1 THEN 120 WHEN 2 THEN 0 WHEN 3 THEN 45 ELSE loyalty_points END;
  `);
}

async function waitForControlFile(name: string, timeoutMs = 30_000): Promise<void> {
  assert.ok(CONTROL_DIR);
  const file = path.join(CONTROL_DIR, name);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file, constants.R_OK);
      return;
    } catch {
      await delay(50);
    }
  }
  assert.fail(`Timed out waiting for showcase control file ${name}`);
}

function postgresAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: SERVER.host, port: SERVER.port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
