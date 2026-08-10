import * as assert from "node:assert";
import { Client } from "pg";
import * as vscode from "vscode";
import type { PgTapCoverageSnapshot } from "../coverageRunProfile.js";
import {
  normalizePgTapTestPatterns,
  openBoundedControlClient,
  type PgTapTestOutcome,
} from "../coverageTestController.js";
import type { PlpgsqlExtensionApi } from "../extension.js";
import type { ServerConfig } from "../serverStore.js";
import { delay, EXT_ID, pgAvailable } from "./testUtils.js";

const PG_TAP_SERVER: ServerConfig = {
  id: "localhost:5433/testdb:postgres",
  name: "postgres@localhost:5433/testdb",
  host: "localhost",
  port: 5433,
  database: "testdb",
  user: "postgres",
};

const NO_PG_TAP_SERVER: ServerConfig = {
  ...PG_TAP_SERVER,
  id: "localhost:5433/postgres:postgres",
  name: "postgres@localhost:5433/postgres",
  database: "postgres",
};

const PG_TAP_ALIAS_SERVER: ServerConfig = {
  ...PG_TAP_SERVER,
  id: "127.0.0.1:5433/testdb:postgres",
  name: "postgres@127.0.0.1:5433/testdb",
  host: "127.0.0.1",
};

suite("pgTAP Test Explorer integration", function () {
  this.timeout(30_000);

  let api: PlpgsqlExtensionApi;
  let previousTestPatterns: string[] | undefined;
  let testPatternsConfigured = false;

  suiteSetup(async function () {
    if (!(await pgAvailable())) this.skip();
    const extension = vscode.extensions.getExtension<PlpgsqlExtensionApi>(EXT_ID);
    assert.ok(extension, "Extension not found");
    api = extension.isActive ? extension.exports : await extension.activate();
    const testConfiguration = vscode.workspace.getConfiguration("postgresql-workbench.tests");
    previousTestPatterns = testConfiguration.inspect<string[]>("patterns")?.workspaceValue;
    await testConfiguration.update(
      "patterns",
      ["*_ut.test_*", "*_it.test_*"],
      vscode.ConfigurationTarget.Workspace,
    );
    testPatternsConfigured = true;
    await withDatabase("postgres", async (client) => {
      await client.query("CREATE EXTENSION IF NOT EXISTS pldbgapi");
    });
    await api.connectionManager.store.add(PG_TAP_SERVER, "postgres");
    await api.connectionManager.store.add(PG_TAP_ALIAS_SERVER, "postgres");
    await api.connectionManager.store.add(NO_PG_TAP_SERVER, "postgres");
    api.coverageTests.refresh();
  });

  suiteTeardown(async () => {
    if (testPatternsConfigured) {
      await vscode.workspace
        .getConfiguration("postgresql-workbench.tests")
        .update("patterns", previousTestPatterns, vscode.ConfigurationTarget.Workspace);
    }
    await api?.connectionManager.disconnect();
    await api?.connectionManager.store.remove(PG_TAP_SERVER.id);
    await api?.connectionManager.store.remove(PG_TAP_ALIAS_SERVER.id);
    await api?.connectionManager.store.remove(NO_PG_TAP_SERVER.id);
    api?.coverageTests.refresh();
  });

  test("validates configured pgTAP discovery patterns defensively", () => {
    assert.deepStrictEqual(normalizePgTapTestPatterns([" quality.check_* ", "  "]), [
      "quality.check_*",
    ]);
    assert.throws(
      () => normalizePgTapTestPatterns("quality.check_*"),
      /must be an array of schema\.function glob strings/,
    );
    assert.throws(
      () => normalizePgTapTestPatterns(["quality.check_*", 42]),
      /must be an array of schema\.function glob strings/,
    );
  });

  test("discovers configured tests lazily for each connection", async () => {
    const controller = api.coverageTests.controller;
    const available = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    const alias = controller.items.get(`connection:${PG_TAP_ALIAS_SERVER.id}`);
    const unavailable = controller.items.get(`connection:${NO_PG_TAP_SERVER.id}`);
    assert.ok(available, "Expected the pgTAP database connection");
    assert.ok(alias, "Expected the second pgTAP connection");
    assert.ok(unavailable, "Expected the database without pgTAP");
    assert.strictEqual(available.children.size, 0, "Discovery must remain lazy");

    await controller.resolveHandler?.(available);
    assert.strictEqual(available.description, "8 pgTAP tests");
    const publicSchema = available.children.get(`schema:${PG_TAP_SERVER.id}:public`);
    assert.ok(publicSchema, "Expected tests grouped under their AST-mapped source schema");

    const overloads = children(publicSchema).filter((item) =>
      item.label.startsWith("coverage_subject("),
    );
    assert.deepStrictEqual(overloads.map(({ label }) => label).sort(), [
      "coverage_subject(value integer)",
      "coverage_subject(value text)",
    ]);
    assert.ok(
      overloads.every((routine) =>
        children(routine).some((test) => test.label.includes("test_coverage_subject")),
      ),
      "The AST dependency mapping should expose the same test under both overloads",
    );
    const unitTest = findTest(available, "test_coverage_subject");
    const integrationTest = findTest(available, "test_coverage_integration");
    assert.ok(unitTest);
    assert.ok(integrationTest);
    assert.strictEqual(unitTest.label, "test_coverage_subject");
    assert.strictEqual(integrationTest.label, "test_coverage_integration");
    assert.strictEqual(api.coverageTests.runProfile.label, "Run pgTAP Tests");
    assert.strictEqual(
      api.coverageTests.coverageProfile.profile.label,
      "Run pgTAP Tests with Coverage",
    );
    await controller.resolveHandler?.(alias);
    assert.strictEqual(alias.description, "8 pgTAP tests");

    await controller.resolveHandler?.(unavailable);
    assert.strictEqual(unavailable.description, "pgTAP not installed");
    assert.match(String(unavailable.error), /Install the pgTAP extension/);

    const revealed = await vscode.commands.executeCommand<boolean>(
      "postgresql-workbench.revealRoutineTests",
      {
        serverId: PG_TAP_SERVER.id,
        oid: api.workbenchIndex.sourceDescriptorForDocumentUri(overloads[0].uri as vscode.Uri)?.oid,
      },
    );
    assert.strictEqual(revealed, true, "The routine command should reveal its pgTAP tests");
  });

  test("refreshes discovery when workspace test patterns change", async () => {
    const controller = api.coverageTests.controller;
    const previousRoot = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(previousRoot);

    const configuration = vscode.workspace.getConfiguration("postgresql-workbench.tests");
    await configuration.update(
      "patterns",
      ["quality.check_*"],
      vscode.ConfigurationTarget.Workspace,
    );
    await waitFor(
      () => controller.items.get(`connection:${PG_TAP_SERVER.id}`) !== previousRoot,
      "Test pattern configuration did not refresh the Test Explorer",
    );

    const customRoot = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(customRoot);
    await controller.resolveHandler?.(customRoot);
    assert.strictEqual(customRoot.description, "1 pgTAP test");
    assert.ok(findTest(customRoot, "check_coverage_subject"));
    assert.strictEqual(findTest(customRoot, "test_coverage_subject"), undefined);

    await configuration.update(
      "patterns",
      ["*_ut.test_*", "*_it.test_*"],
      vscode.ConfigurationTarget.Workspace,
    );
    await waitFor(
      () => controller.items.get(`connection:${PG_TAP_SERVER.id}`) !== customRoot,
      "Restoring test patterns did not refresh the Test Explorer",
    );
  });

  test("runs passing and failing tests through the native VS Code test result model", async () => {
    const root = api.coverageTests.controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await api.coverageTests.controller.resolveHandler?.(root);

    const passing = findTest(root, "test_coverage_subject");
    const failing = findTest(root, "test_coverage_failure");
    const erroring = findTest(root, "test_coverage_error");
    const malformed = findTest(root, "test_coverage_invalid_tap");
    const parameterized = findTest(root, "test_requires_argument");
    assert.ok(passing, "Missing passing pgTAP test");
    assert.ok(failing, "Missing failing pgTAP test");
    assert.ok(erroring, "Missing erroring pgTAP test");
    assert.ok(malformed, "Missing malformed pgTAP test");
    assert.ok(parameterized, "Missing parameterized pgTAP test");
    assert.strictEqual(
      api.workbenchIndex.sourceDescriptorForDocumentUri(passing.uri as vscode.Uri)?.serverId,
      PG_TAP_SERVER.id,
    );

    const cancellation = new vscode.CancellationTokenSource();
    const outcomes = await runProfile(
      api,
      new vscode.TestRunRequest([passing, failing, erroring, malformed, parameterized]),
      cancellation.token,
    );
    cancellation.dispose();

    assert.strictEqual(outcomes.get(passing.id), "passed");
    assert.strictEqual(outcomes.get(failing.id), "failed");
    assert.strictEqual(outcomes.get(erroring.id), "errored");
    assert.strictEqual(outcomes.get(malformed.id), "errored");
    assert.strictEqual(outcomes.get(parameterized.id), "errored");

    const aliasRoot = api.coverageTests.controller.items.get(
      `connection:${PG_TAP_ALIAS_SERVER.id}`,
    );
    assert.ok(aliasRoot);
    if (aliasRoot.children.size === 0) {
      await api.coverageTests.controller.resolveHandler?.(aliasRoot);
    }
    const aliasPassing = findTest(aliasRoot, "test_coverage_subject");
    assert.ok(aliasPassing);
    const aliasCancellation = new vscode.CancellationTokenSource();
    const aliasOutcomes = await runProfile(
      api,
      new vscode.TestRunRequest([aliasPassing]),
      aliasCancellation.token,
    );
    aliasCancellation.dispose();
    assert.strictEqual(aliasOutcomes.get(aliasPassing.id), "passed");
    assert.notStrictEqual(aliasPassing.id, passing.id);
  });

  test("cancels a running PostgreSQL test and invalidates stale connection items", async () => {
    const controller = api.coverageTests.controller;
    const originalRoot = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(originalRoot);
    if (originalRoot.children.size === 0) await controller.resolveHandler?.(originalRoot);
    const slow = findTest(originalRoot, "test_coverage_slow");
    assert.ok(slow, "Missing cancellable pgTAP test");

    const cancellation = new vscode.CancellationTokenSource();
    const startedAt = Date.now();
    const running = runProfile(api, new vscode.TestRunRequest([slow]), cancellation.token);
    setTimeout(() => cancellation.cancel(), 100);
    const outcomes = await running;
    cancellation.dispose();

    assert.strictEqual(outcomes.get(slow.id), "skipped");
    assert.ok(Date.now() - startedAt < 5_000, "Cancellation should not wait for pg_sleep");

    await withDatabase("testdb", async (client) => {
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = 'postgresql-workbench:test-runner'",
      );
      assert.strictEqual(active.rows[0]?.count, "0");
    });

    const followup = findTest(originalRoot, "test_coverage_subject");
    assert.ok(followup);
    const followupCancellation = new vscode.CancellationTokenSource();
    const followupOutcomes = await runProfile(
      api,
      new vscode.TestRunRequest([followup]),
      followupCancellation.token,
    );
    followupCancellation.dispose();
    assert.strictEqual(followupOutcomes.get(followup.id), "passed");

    assert.strictEqual(await api.connectionManager.connectServer(NO_PG_TAP_SERVER.id), true);
    const refreshedRoot = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(refreshedRoot);
    assert.notStrictEqual(
      refreshedRoot,
      originalRoot,
      "A connection refresh must replace stale test items",
    );

    const source = await vscode.workspace.openTextDocument(followup.uri as vscode.Uri);
    assert.match(source.getText(), /FUNCTION public_ut\.test_coverage_subject\(\)/);
  });

  test("closes a control connection that completes after its timeout", async () => {
    const lateClient = new Client({
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      password: "postgres",
      application_name: "postgresql-workbench:late-control-test",
    });
    const pending = delay(100).then(async () => {
      await lateClient.connect();
      return lateClient;
    });

    await assert.rejects(
      openBoundedControlClient(() => pending, 10),
      /cancellation connection timed out/,
    );
    await pending;
    await delay(100);

    await withDatabase("testdb", async (client) => {
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = 'postgresql-workbench:late-control-test'",
      );
      assert.strictEqual(active.rows[0]?.count, "0");
    });
  });

  test("skips implicitly selected tests that cannot produce coverage", async () => {
    const controller = api.coverageTests.controller;
    const root = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await controller.resolveHandler?.(root);
    const slowTests = findTests(root, "test_coverage_slow");
    const ineligible = [
      ...findTests(root, "test_coverage_error"),
      ...findTests(root, "test_coverage_invalid_tap"),
      ...findTests(root, "test_requires_argument"),
    ];
    assert.ok(slowTests.length > 0);
    assert.ok(ineligible.length > 0);
    const mappedError = findTest(root, "test_coverage_mapped_error");
    const followup = findTest(root, "test_coverage_subject");
    assert.ok(mappedError);
    assert.ok(followup);

    const cancellation = new vscode.CancellationTokenSource();
    const snapshot = await runCoverageProfile(
      api,
      new vscode.TestRunRequest([root], slowTests),
      cancellation.token,
    );
    cancellation.dispose();

    for (const item of ineligible) {
      assert.strictEqual(
        snapshot.outcomes.get(item.id),
        "skipped",
        `${item.label} should be skipped when inherited from a suite selection`,
      );
    }
    assert.strictEqual(snapshot.outcomes.get(mappedError.id), "errored");
    assert.strictEqual(
      snapshot.outcomes.get(followup.id),
      "passed",
      "A mapped test after an SQL error should still execute in its own savepoint",
    );
  });

  test("publishes native statement and branch coverage and rejects stale source details", async () => {
    const controller = api.coverageTests.controller;
    const root = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await controller.resolveHandler?.(root);
    const wrapperTest = findTest(root, "test_coverage_integration");
    assert.ok(wrapperTest);

    const cancellation = new vscode.CancellationTokenSource();
    const snapshot = await runCoverageProfile(
      api,
      new vscode.TestRunRequest([wrapperTest]),
      cancellation.token,
    );
    cancellation.dispose();

    assert.strictEqual(snapshot.outcomes.get(wrapperTest.id), "passed");
    assert.strictEqual(snapshot.files.length, 3);
    const subjectCoverage = snapshot.files.find((file) =>
      file.uri.path.includes("coverage_subject"),
    );
    assert.ok(subjectCoverage, "Expected coverage for public.coverage_subject");
    assert.ok(subjectCoverage.statementCoverage.total > 0);
    assert.ok(subjectCoverage.statementCoverage.covered > 0);
    assert.ok((subjectCoverage.branchCoverage?.total ?? 0) > 0);
    assert.deepStrictEqual(subjectCoverage.includesTests, [wrapperTest]);

    const detailCancellation = new vscode.CancellationTokenSource();
    const details = await api.coverageTests.coverageProfile.profile.loadDetailedCoverage?.(
      snapshot.run,
      subjectCoverage,
      detailCancellation.token,
    );
    assert.ok(details);
    const testDetails =
      await api.coverageTests.coverageProfile.profile.loadDetailedCoverageForTest?.(
        snapshot.run,
        subjectCoverage,
        wrapperTest,
        detailCancellation.token,
      );
    assert.ok(testDetails, "Expected native per-test coverage details");
    const statements = details.filter(
      (detail): detail is vscode.StatementCoverage => detail instanceof vscode.StatementCoverage,
    );
    assert.ok(statements.some(({ branches }) => branches.length > 0));
    assert.strictEqual(subjectCoverage.statementCoverage.total, statements.length);
    assert.strictEqual(
      subjectCoverage.statementCoverage.covered,
      statements.filter(({ executed }) => Number(executed) > 0).length,
    );
    const branches = statements.flatMap(({ branches: statementBranches }) => statementBranches);
    assert.strictEqual(subjectCoverage.branchCoverage?.total, branches.length);
    assert.strictEqual(
      subjectCoverage.branchCoverage?.covered,
      branches.filter(({ executed }) => Number(executed) > 0).length,
    );
    const document = await vscode.workspace.openTextDocument(subjectCoverage.uri);
    assert.ok(
      statements.some((statement) => {
        const line =
          statement.location instanceof vscode.Range
            ? statement.location.start.line
            : statement.location.line;
        return document.lineAt(line).text.includes("IF value >= 0 THEN");
      }),
      "Branch coverage should map to the PL/pgSQL decision line",
    );

    await withDatabase("testdb", async (client) => {
      const descriptor = api.workbenchIndex.sourceDescriptorForDocumentUri(subjectCoverage.uri);
      assert.ok(descriptor, "Coverage URI must resolve through the Code Moniker registry");
      const oid = descriptor.oid;
      const current = await client.query<{ ddl: string }>(
        "SELECT pg_get_functiondef($1::oid) AS ddl",
        [oid],
      );
      const original = current.rows[0]?.ddl;
      assert.ok(original);
      try {
        await client.query(
          original.replace("BEGIN", "BEGIN\n  -- source changed after coverage collection"),
        );
        await assert.rejects(
          api.coverageTests.coverageProfile.profile.loadDetailedCoverage?.(
            snapshot.run,
            subjectCoverage,
            detailCancellation.token,
          ) as Promise<vscode.FileCoverageDetail[]>,
          /changed after coverage was collected/,
        );
        assert.strictEqual(
          await api.coverageTests.coverageProfile.exportLastCoverage(),
          false,
          "A stale coverage snapshot must not be exported",
        );
      } finally {
        await client.query(original);
      }
    });
    detailCancellation.dispose();
  });

  test("maps both hit and missed statements for a partial coverage run", async () => {
    const controller = api.coverageTests.controller;
    const root = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await controller.resolveHandler?.(root);
    const routineOid = await resolveRoutineOid("public.coverage_subject(integer)");
    const routineSymbolUri = api.workbenchIndex.routineSymbol(PG_TAP_SERVER.id, routineOid)?.uri;
    assert.ok(routineSymbolUri, "Expected the indexed Code Moniker routine URI");
    const partial = findTests(root, "test_coverage_failure").find((item) =>
      item.id.endsWith(`:source:${routineSymbolUri}`),
    );
    assert.ok(partial, "Expected the failing test mapped to the integer overload");

    const cancellation = new vscode.CancellationTokenSource();
    const snapshot = await runCoverageProfile(
      api,
      new vscode.TestRunRequest([partial]),
      cancellation.token,
    );
    cancellation.dispose();

    assert.strictEqual(snapshot.outcomes.get(partial.id), "failed");
    const file = snapshot.files.find(
      ({ uri }) => api.workbenchIndex.sourceDescriptorForDocumentUri(uri)?.oid === routineOid,
    );
    assert.ok(file, "Expected coverage for the selected integer overload");
    const detailsCancellation = new vscode.CancellationTokenSource();
    const details = await api.coverageTests.coverageProfile.profile.loadDetailedCoverage?.(
      snapshot.run,
      file,
      detailsCancellation.token,
    );
    assert.ok(details);
    assert.deepStrictEqual(file.includesTests, [partial]);
    const perTestDetails =
      await api.coverageTests.coverageProfile.profile.loadDetailedCoverageForTest?.(
        snapshot.run,
        file,
        partial,
        detailsCancellation.token,
      );
    assert.ok(perTestDetails, "Expected coverage attributable to the selected pgTAP test");
    detailsCancellation.dispose();
    const statements = details.filter(
      (detail): detail is vscode.StatementCoverage => detail instanceof vscode.StatementCoverage,
    );
    assert.ok(statements.some(({ executed }) => Number(executed) > 0));
    assert.ok(statements.some(({ executed }) => Number(executed) === 0));

    const document = await vscode.workspace.openTextDocument(file.uri);
    const loopBody = statements.find((statement) =>
      document.lineAt(coverageLine(statement)).text.includes("total := total + index"),
    );
    const forHeader = statements.find((statement) =>
      document.lineAt(coverageLine(statement)).text.includes("FOR index IN 1..value LOOP"),
    );
    const alternative = statements.find((statement) =>
      document.lineAt(coverageLine(statement)).text.includes("total := value"),
    );
    assert.ok(forHeader, "Expected statement coverage on the FOR header");
    assert.ok(loopBody, "Expected coverage on the loop body");
    assert.ok(alternative, "Expected coverage on the alternative branch");
    assert.ok(Number(forHeader.executed) > 0, "The FOR statement should be covered");
    assert.ok(forHeader.branches.length > 0, "The FOR statement should retain loop branches");
    assert.ok(Number(loopBody.executed) > 0, "The loop body should be covered");
    assert.strictEqual(Number(alternative.executed), 0, "The alternative branch should be missed");
  });

  test("returns different native details for different tests covering the same routine", async () => {
    const controller = api.coverageTests.controller;
    const root = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await controller.resolveHandler?.(root);
    const routineOid = await resolveRoutineOid("public.coverage_subject(integer)");
    const routineSymbolUri = api.workbenchIndex.routineSymbol(PG_TAP_SERVER.id, routineOid)?.uri;
    assert.ok(routineSymbolUri);
    const sourceSuffix = `:source:${routineSymbolUri}`;
    const broad = findTests(root, "test_coverage_subject").find((item) =>
      item.id.endsWith(sourceSuffix),
    );
    const narrow = findTests(root, "test_coverage_failure").find((item) =>
      item.id.endsWith(sourceSuffix),
    );
    assert.ok(broad);
    assert.ok(narrow);

    const cancellation = new vscode.CancellationTokenSource();
    const snapshot = await runCoverageProfile(
      api,
      new vscode.TestRunRequest([broad, narrow]),
      cancellation.token,
    );
    cancellation.dispose();
    const file = snapshot.files.find(
      ({ uri }) => api.workbenchIndex.sourceDescriptorForDocumentUri(uri)?.oid === routineOid,
    );
    assert.ok(file);
    assert.deepStrictEqual(new Set(file.includesTests), new Set([broad, narrow]));
    const detailsCancellation = new vscode.CancellationTokenSource();
    const broadDetails =
      await api.coverageTests.coverageProfile.profile.loadDetailedCoverageForTest?.(
        snapshot.run,
        file,
        broad,
        detailsCancellation.token,
      );
    const narrowDetails =
      await api.coverageTests.coverageProfile.profile.loadDetailedCoverageForTest?.(
        snapshot.run,
        file,
        narrow,
        detailsCancellation.token,
      );
    detailsCancellation.dispose();
    assert.ok(broadDetails);
    assert.ok(narrowDetails);
    assert.notDeepStrictEqual(coverageExecutions(broadDetails), coverageExecutions(narrowDetails));
  });

  test("cancels native coverage and restores the instrumented routine", async () => {
    const controller = api.coverageTests.controller;
    const root = controller.items.get(`connection:${PG_TAP_SERVER.id}`);
    assert.ok(root);
    if (root.children.size === 0) await controller.resolveHandler?.(root);
    const slow = findTest(root, "test_coverage_slow");
    assert.ok(slow);
    const sourceMarker = slow.id.lastIndexOf(":source:");
    assert.ok(sourceMarker >= 0, `Expected a mapped Code Moniker source URI in ${slow.id}`);
    const sourceSymbolUri = slow.id.slice(sourceMarker + ":source:".length);
    const sourceDescriptor = api.workbenchIndex.sourceDescriptor(sourceSymbolUri);
    assert.ok(sourceDescriptor, `Expected a source descriptor for ${sourceSymbolUri}`);
    const routineOid = sourceDescriptor.oid;
    const before = await routineDdl(routineOid);

    const cancellation = new vscode.CancellationTokenSource();
    const running = runCoverageProfile(api, new vscode.TestRunRequest([slow]), cancellation.token);
    setTimeout(() => cancellation.cancel(), 100);
    const snapshot = await running;
    cancellation.dispose();

    assert.strictEqual(snapshot.outcomes.get(slow.id), "skipped");
    assert.strictEqual(snapshot.files.length, 0);
    assert.strictEqual(await routineDdl(routineOid), before);
    await withDatabase("testdb", async (client) => {
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = 'postgresql-workbench:coverage-runner'",
      );
      assert.strictEqual(active.rows[0]?.count, "0");
    });
  });
});

async function runProfile(
  api: PlpgsqlExtensionApi,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<ReadonlyMap<string, PgTapTestOutcome>> {
  const completed = new Promise<ReadonlyMap<string, PgTapTestOutcome>>((resolve) => {
    const subscription = api.coverageTests.onDidCompleteRun((outcomes) => {
      subscription.dispose();
      resolve(outcomes);
    });
  });
  await api.coverageTests.runProfile.runHandler(request, token);
  return completed;
}

async function runCoverageProfile(
  api: PlpgsqlExtensionApi,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<PgTapCoverageSnapshot> {
  const completed = new Promise<PgTapCoverageSnapshot>((resolve) => {
    const subscription = api.coverageTests.coverageProfile.onDidComplete((snapshot) => {
      subscription.dispose();
      resolve(snapshot);
    });
  });
  await api.coverageTests.coverageProfile.profile.runHandler(request, token);
  return completed;
}

async function withDatabase(
  database: string,
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({
    host: "localhost",
    port: 5433,
    database,
    user: "postgres",
    password: "postgres",
  });
  await client.connect();
  try {
    await action(client);
  } finally {
    await client.end();
  }
}

async function routineDdl(oid: number): Promise<string> {
  let ddl = "";
  await withDatabase("testdb", async (client) => {
    const result = await client.query<{ ddl: string }>(
      "SELECT pg_get_functiondef($1::oid) AS ddl",
      [oid],
    );
    ddl = result.rows[0]?.ddl ?? "";
  });
  return ddl;
}

async function resolveRoutineOid(signature: string): Promise<number> {
  let oid = 0;
  await withDatabase("testdb", async (client) => {
    const result = await client.query<{ oid: string }>("SELECT $1::regprocedure::oid AS oid", [
      signature,
    ]);
    oid = Number(result.rows[0]?.oid);
  });
  return oid;
}

function coverageLine(statement: vscode.StatementCoverage): number {
  return statement.location instanceof vscode.Range
    ? statement.location.start.line
    : statement.location.line;
}

function coverageExecutions(details: readonly vscode.FileCoverageDetail[]): number[] {
  return details.flatMap((detail) => {
    if (!(detail instanceof vscode.StatementCoverage)) return [];
    return [Number(detail.executed), ...detail.branches.map((branch) => Number(branch.executed))];
  });
}

function children(item: vscode.TestItem): vscode.TestItem[] {
  const result: vscode.TestItem[] = [];
  item.children.forEach((child) => {
    result.push(child);
  });
  return result;
}

function findTest(root: vscode.TestItem, label: string): vscode.TestItem | undefined {
  if (root.label.includes(label)) return root;
  for (const child of children(root)) {
    const found = findTest(child, label);
    if (found) return found;
  }
  return undefined;
}

function findTests(root: vscode.TestItem, label: string): vscode.TestItem[] {
  const result = root.label.includes(label) ? [root] : [];
  for (const child of children(root)) result.push(...findTests(child, label));
  return result;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}
