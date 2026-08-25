import * as assert from "node:assert";
import { constants } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import * as net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import {
  buildWorkbenchObjects,
  type WorkbenchObjectModel,
} from "../../packages/catalog/src/objectModel.js";
import {
  dataViewColumnKeys,
  type DataViewEdit,
  dataViewRelationOwning,
} from "../../packages/rows/src/dataView/dataView.js";
import type { WorkbenchGraphWebviewMessage } from "../../packages/views/src/cockpit/protocol.js";
import {
  delay,
  EXT_ID,
  stopActivePlpgsqlSession,
  waitForSessionStart,
} from "../tests/vscode/integration/testUtils.js";
import type { PgTapCoverageSnapshot } from "../src/coverage/index.js";
import type { DataViewDocument } from "../src/dataView/dataViewDocument.js";
import type { PlpgsqlExtensionApi } from "../src/extension.js";
import { NEW_SQL_NOTEBOOK_COMMAND, SQL_NOTEBOOK_RESULT_MIME } from "../src/scratchpad/index.js";

const SCENE = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_SCENE;
const CONTROL_DIR = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_CONTROL_DIR;
const THEME = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_THEME ?? "light";
const EXPECTED_EXTENSION_PATH = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_PATH;
const EXPECTED_EXTENSION_VERSION = process.env.POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_VERSION;
const CONNECTION = {
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
    assert.ok(EXPECTED_EXTENSION_PATH, "POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_PATH is required");
    assert.ok(
      EXPECTED_EXTENSION_VERSION,
      "POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_VERSION is required",
    );
    assert.ok(await postgresAvailable(), "The PostgreSQL demo is not available on port 5434");
    await forceShowcaseTheme();

    const extension = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXT_ID);
    assert.ok(extension, "PostgreSQL Workbench extension is unavailable");
    assert.strictEqual(
      await realpath(extension.extensionPath),
      await realpath(EXPECTED_EXTENSION_PATH),
      "The showcase must load PostgreSQL Workbench from the extracted VSIX",
    );
    assert.strictEqual(
      extension.packageJSON.version,
      EXPECTED_EXTENSION_VERSION,
      "The showcase must load the configured VSIX version",
    );
    process.stdout.write(
      `Verified showcase extension ${EXT_ID}@${extension.packageJSON.version} ` +
        `from ${extension.extensionPath}\n`,
    );
    api = extension.isActive ? extension.exports : await extension.activate();
    await api.connectionManager.store.add(CONNECTION, "postgres");
    assert.strictEqual(
      await vscode.commands.executeCommand("postgresql-workbench.connectConnection", CONNECTION.id),
      true,
    );
    assert.ok(
      await vscode.commands.executeCommand("postgresql-workbench.indexDatabase"),
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
    if (api) {
      for (const id of api.connectionManager.connectedConnectionIds) {
        await api.connectionManager.disconnect(id);
      }
    }
    await api?.connectionManager.store.remove(CONNECTION.id).catch(() => {});
  });

  test("runs the selected feature choreography", async () => {
    switch (SCENE) {
      case "data-view":
        await dataViewScene(api);
        break;
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

/**
 * The Data View, from a table to a change waiting to be written: a related table joined on the key
 * the planner derives, an order, a `WHERE` reaching into the joined relation, and one value
 * corrected.
 *
 * The scene drives the document through the very requests its own webview sends, so what is filmed
 * is the path a reader takes, not a rehearsal of it beside them.
 *
 * `shop.product` carries a JSON payload, an array, a URL and a thumbnail. Left in, they push the
 * joined table off the right edge and the card shows a join nobody can see, so they are hidden
 * before the recording starts — with the control the view offers for exactly that.
 */
const PRODUCT_NOISE = [
  "description",
  "active",
  "attributes",
  "supplier_payload",
  "tags",
  "datasheet_url",
  "thumbnail",
];

async function dataViewScene(api: PlpgsqlExtensionApi): Promise<void> {
  const product = object(api, "shop", "product", "table");
  await api.dataViews.open({
    kind: "relation",
    connectionId: CONNECTION.id,
    database: CONNECTION.database,
    schema: product.schema,
    name: product.name,
    relationKind: "table",
  });
  const view = await waitForDataViewRows(api);
  for (const column of PRODUCT_NOISE) {
    await view.handle({ type: "data-view/hide", column: columnKey(view, column) });
  }
  /* Hiding is local to the view, so nothing is awaited — but the grid must be narrow before the
   * recorder starts, or the joined table lands off the edge again. */
  assert.strictEqual(
    view.state().query.hidden.length >= PRODUCT_NOISE.length,
    true,
    "The Data View did not narrow before the recording",
  );

  await record(async () => {
    await delay(700);

    /* A related table joins on the key the planner derives from the foreign keys. */
    const brand = view
      .additions()
      .find((item) => item.kind === "table" && item.label === "shop.brand");
    assert.ok(brand, "shop.brand is not offered as a related table of shop.product");
    await view.handle({ type: "data-view/compose", addition: brand });
    /* A column only the joined table has: `name` would be answered by the one already there. */
    await waitForDataViewColumn(view, "website");
    await delay(1900);

    await view.handle({
      type: "data-view/sort",
      sorts: [{ column: "price", direction: "descending" }],
    });
    await delay(1600);

    /*
     * Filtering on what a cell holds, the way the cell's own menu does it: two of the four
     * products carry this brand, so the rows visibly narrow to the ones that share the value —
     * and the condition is written into the WHERE, where it can be read, corrected and undone.
     */
    const brandName = ordinalOf(view, "name", ["shop", "brand"]);
    const before = view.state().payload?.rows.length ?? 0;
    await view.handle({
      type: "data-view/filter-cell",
      ordinal: brandName,
      value: view.state().payload?.rows[0]?.[brandName]?.value ?? null,
      negate: false,
    });
    /* Several rows share it and some do not: a filter that keeps everything, or one row, shows
     * nothing happening. The card would film a gesture with no visible answer. */
    const kept = view.state().payload?.rows.length ?? 0;
    assert.ok(
      kept >= 2 && kept < before,
      `Filtering on the value kept ${kept} of ${before} rows; the card needs several, not all`,
    );
    await delay(2400);

    /*
     * A correction is not filmed. A pending edit is only drawn once a reader turns edit mode on,
     * and that is the view's own state, not something a host can ask for — so sending one would
     * spend two seconds of the card on a grid that does not visibly change. What the rows being
     * writable is worth is asserted instead, below.
     */
    editableCell(view, "price", "26.50");

    /* And it was SQL all along: the composed query opens beside the rows it drew. */
    await view.handle({ type: "data-view/edit-query" });
    await delay(2400);
  });
}

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
  const uri = await vscode.commands.executeCommand<vscode.Uri>(NEW_SQL_NOTEBOOK_COMMAND, CONNECTION.id);
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
  assert.ok(await api.coverageTests.revealRoutine(CONNECTION.id, routine.oid));

  await record(async () => {
    await delay(650);
    const completed = waitForCoverage(api);
    await vscode.commands.executeCommand("testing.coverageSelected");
    const coverage = await completed;
    assert.ok(coverage.files.length > 0, "The coverage run must publish at least one file");
    await assertRestockLoopCovered(api, coverage, routine);
    await vscode.commands.executeCommand("testing.openCoverage");
    const uri = api.workbenchSourceUris.documentUri(routine.symbolUri);
    assert.ok(uri);
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
    await delay(500);
    await vscode.commands.executeCommand("testing.toggleInlineCoverage");
    await delay(3200);
  });
}

async function assertRestockLoopCovered(
  api: PlpgsqlExtensionApi,
  coverage: PgTapCoverageSnapshot,
  routine: WorkbenchObjectModel,
): Promise<void> {
  const file = coverage.files.find(
    ({ uri }) => api.workbenchSourceUris.sourceDescriptorForDocumentUri(uri)?.oid === routine.oid,
  );
  assert.ok(file, "The coverage run must include shop.restock_report");
  const cancellation = new vscode.CancellationTokenSource();
  let details: vscode.FileCoverageDetail[] | undefined;
  try {
    details = await api.coverageTests.coverageProfile.profile.loadDetailedCoverage?.(
      coverage.run,
      file,
      cancellation.token,
    );
  } finally {
    cancellation.dispose();
  }
  assert.ok(details, "The coverage run must expose native details for shop.restock_report");
  const document = await vscode.workspace.openTextDocument(file.uri);
  const loop = details.find(
    (detail): detail is vscode.StatementCoverage =>
      detail instanceof vscode.StatementCoverage &&
      document.lineAt(coverageLine(detail)).text.includes("FOR rec IN SELECT"),
  );
  assert.ok(loop, "The coverage run must expose the restock FOR loop");
  assert.ok(Number(loop.executed) > 0, "The executed restock FOR loop must be covered");
  assert.equal(loop.branches.length, 2, "The restock FOR loop must expose enter and exit branches");
  assert.ok(
    loop.branches.every(({ executed }) => Number(executed) > 0),
    "Entering and normally exiting the restock FOR loop must cover both loop branches",
  );
}

function coverageLine(statement: vscode.StatementCoverage): number {
  return statement.location instanceof vscode.Range
    ? statement.location.start.line
    : statement.location.line;
}

async function debuggerScene(api: PlpgsqlExtensionApi): Promise<void> {
  await resetShopDebugData(api);
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "The showcase demo workspace is unavailable");
  const callsite = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspace.uri, "debug-me.sql"),
  );
  await vscode.window.showTextDocument(callsite, { preview: false, preserveFocus: false });

  const sessionStarted = waitForSessionStart(20_000);
  assert.strictEqual(
    await vscode.debug.startDebugging(undefined, {
      type: "postgresql-workbench",
      request: "launch",
      name: "Showcase: place_order",
      connection: CONNECTION.id,
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
  return new Promise<PgTapCoverageSnapshot>((resolve, reject) => {
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
  const database = { connectionId: CONNECTION.id, database: CONNECTION.database };
  const target = buildWorkbenchObjects(api.workbenchIndex.databaseSymbols(database), database).find(
    (candidate) =>
      candidate.schema === schema && candidate.name === name && candidate.kind === kind,
  );
  assert.ok(target, `Missing indexed ${kind} ${schema}.${name}`);
  return target;
}

function snapshot(api: PlpgsqlExtensionApi) {
  const result = api.workbenchIndex.databaseState({
    connectionId: CONNECTION.id,
    database: CONNECTION.database,
  }).result;
  assert.ok(result);
  return {
    connectionId: result.connectionId,
    database: result.database,
    revision: result.revision,
    generation: result.generation,
  };
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

/** The Data View the scene opened, once PostgreSQL has answered with its first rows. */
async function waitForDataViewRows(
  api: PlpgsqlExtensionApi,
  timeoutMs = 30_000,
): Promise<DataViewDocument> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = api.dataViews.opened().at(-1);
    if (view && !view.state().busy && (view.state().payload?.rows.length ?? 0) > 0) return view;
    await delay(200);
  }
  assert.fail("The Data View did not load its rows");
}

/** Waits for a composition to land: the column it brought in is drawn with the others. */
async function waitForDataViewColumn(
  view: DataViewDocument,
  column: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const columns = view.state().payload?.columns ?? [];
    if (!view.state().busy && columns.some((candidate) => candidate.name === column)) return;
    await delay(150);
  }
  assert.fail(`The Data View never drew the column ${column}`);
}

/** How a column is named to the requests that hide it: by its table, so a join cannot confuse two. */
function columnKey(view: DataViewDocument, column: string): string {
  const state = view.state();
  const names = state.payload?.columns.map((candidate) => candidate.name) ?? [];
  return dataViewColumnKeys(state.projection, names)[ordinalOf(view, column)] ?? column;
}

/**
 * Which column of the grid a name means. A join puts two `name` columns side by side, so a name
 * alone is only enough where one relation is in play; naming the relation settles it.
 */
function ordinalOf(view: DataViewDocument, column: string, relation?: [string, string]): number {
  const state = view.state();
  const columns = state.payload?.columns ?? [];
  if (!relation) {
    const ordinal = columns.findIndex((candidate) => candidate.name === column);
    assert.ok(ordinal >= 0, `The Data View has no column ${column}`);
    return ordinal;
  }
  const [schema, name] = relation;
  const owned = dataViewRelationOwning(state.projection, schema, name);
  assert.ok(owned, `${schema}.${name} is not part of the query`);
  const ordinal = owned.ownedOrdinals.find((candidate) => columns[candidate]?.name === column);
  assert.ok(ordinal !== undefined, `${schema}.${name} does not project ${column}`);
  return ordinal;
}

/**
 * Correcting one named value, on the first row the grid is showing — assembled from the policy the
 * grid itself reads, so what this builds is what the product would send.
 *
 * The card does not film it. What it asserts is what the card claims by showing these rows at all:
 * that a value drawn across a join is one the reader could write to, and that the query says which
 * stored row it belongs to.
 */
function editableCell(view: DataViewDocument, column: string, value: string): DataViewEdit {
  const state = view.state();
  const ordinal = ordinalOf(view, column);
  const policy = state.editability.columns[ordinal];
  assert.ok(policy?.editable, `The Data View refuses to write ${column}`);
  const table = state.editability.tables.find(
    (candidate) => candidate.tableOid === policy.tableOid,
  );
  assert.ok(table, `No writable table owns ${column}`);
  const row = state.payload?.rows[0];
  assert.ok(row, "The Data View is showing no row to correct");
  return {
    tableOid: policy.tableOid,
    key: table.keyOrdinals.map((keyOrdinal) => row[keyOrdinal]?.value ?? null),
    ordinal,
    column: policy.column,
    original: row[ordinal]?.value ?? null,
    value,
  };
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
  const firstConnected = api.connectionManager.connectedConnectionIds[0];
  const client = firstConnected ? api.connectionManager.getClient(firstConnected) : undefined;
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
    const socket = net.createConnection({ host: CONNECTION.host, port: CONNECTION.port }, () => {
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
