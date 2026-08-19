import {
  demoDatabaseTreeItem as database,
  demoAssociationText,
  demoAutomaticAssociationText,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";

const resultMime = "application/vnd.postgresql-workbench.sql-result+json";

test.describe("Scratchpads", () => {
  test("keeps one associated Scratchpad transaction explicit from execution to resolution", async ({
    demoDatabase,
    workbench,
    notebook,
    vscode,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    const scratchpad = await createScratchpad(workbench, notebook, demoAssociationText);

    await test.step("show the Scratchpad once in its dedicated view with its automatic Association", async () => {
      await expect(scratchpad).toContainText(demoAutomaticAssociationText);
    });

    await test.step("prepare a clean PostgreSQL observation outside the future Transaction", async () => {
      const cleanup = notebook.cell(0);
      await notebook.typeInCell(
        cleanup,
        "DROP TABLE IF EXISTS public.acceptance_scratchpad_transaction",
      );
      await notebook.executeCode(cleanup);
      await expect
        .poll(
          async () =>
            (await demoDatabase.inspectTable("public", "acceptance_scratchpad_transaction")).exists,
        )
        .toBe(false);
    });

    await test.step("switch the persistent Mode to MANUAL from the Scratchpad", async () => {
      await workbench.scratchpads.setMode(scratchpad, "MANUAL");
    });

    await test.step("keep Transaction control owned by the Scratchpad", async () => {
      const transactionControl = await notebook.addCodeCell();
      await notebook.typeInCell(transactionControl, "COMMIT");
      await notebook.executeCode(transactionControl);
      const errorFrame = await notebook.frameContainingText("Scratchpad Transaction control");
      await expect(errorFrame.locator(".sql-error")).toContainText(
        "Use the Scratchpad Transaction controls",
      );
      await workbench.scratchpads.expectNoTransaction(scratchpad);
    });

    await test.step("open one Transaction on first execution and keep its work private", async () => {
      const code = await notebook.addCodeCell();
      await notebook.typeInCell(
        code,
        [
          "CREATE TABLE public.acceptance_scratchpad_transaction(id integer PRIMARY KEY);",
          "INSERT INTO public.acceptance_scratchpad_transaction VALUES (1);",
          "SELECT id FROM public.acceptance_scratchpad_transaction;",
        ].join("\n"),
      );
      await notebook.executeCode(code);

      const result = await notebook.resultFrame("1");
      await expect(result.getByText("1", { exact: true })).toBeVisible({ timeout: 10_000 });
      await workbench.scratchpads.expand(scratchpad);
      const transaction = await workbench.scratchpads.transaction(scratchpad, "in progress");
      await expect(transaction).toContainText("3 Statements", { timeout: 5_000 });
      await expect
        .poll(
          async () =>
            (await demoDatabase.inspectTable("public", "acceptance_scratchpad_transaction")).exists,
        )
        .toBe(false);
    });

    await test.step("leave the Transaction active when the Scratchpad editor closes", async () => {
      await vscode.executeCommand("workbench.action.files.saveAll");
      await notebook.closeActive();
      await expect(
        await workbench.scratchpads.transaction(scratchpad, "in progress"),
      ).toContainText("3 Statements");
      await scratchpad.click();
      await notebook.activateLatestScratchpad();
    });

    await test.step("guard a Mode change while the Transaction is active", async () => {
      await workbench.scratchpads.requestMode(scratchpad, "AUTO");
      const cancel = workbench.page.getByRole("button", { name: "Cancel", exact: true });
      await expect(cancel).toBeVisible({ timeout: 5_000 });
      await cancel.click();
      await expect(scratchpad).toContainText(/MANUAL/u);
      await expect(
        await workbench.scratchpads.transaction(scratchpad, "in progress"),
      ).toContainText("3 Statements");
    });

    await test.step("commit explicitly and make the PostgreSQL change externally visible", async () => {
      await workbench.scratchpads.commit(scratchpad);
      await expect
        .poll(
          async () =>
            (await demoDatabase.inspectTable("public", "acceptance_scratchpad_transaction")).exists,
        )
        .toBe(true);
    });

    await test.step("surface a failed Transaction and leave Rollback as its resolution", async () => {
      const failing = await notebook.addCodeCell();
      await notebook.typeInCell(failing, "INSERT INTO public.table_that_does_not_exist VALUES (1)");
      await notebook.executeCode(failing);
      await expect
        .poll(async () => (await notebook.snapshot())?.cells.at(-1)?.outputGroups.length, {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
      const failed = await workbench.scratchpads.transaction(scratchpad, "failed");
      await expect(failed).toBeVisible({ timeout: 5_000 });
      await expect(failed.getByLabel("Commit", { exact: true })).toHaveCount(0);
      await workbench.scratchpads.rollback(scratchpad);
    });

    await test.step("return to AUTO while idle and clean up independently", async () => {
      await workbench.scratchpads.setMode(scratchpad, "AUTO");

      const cleanup = await notebook.addCodeCell();
      await notebook.typeInCell(cleanup, "DROP TABLE public.acceptance_scratchpad_transaction");
      await notebook.executeCode(cleanup);
      await expect
        .poll(
          async () =>
            (await demoDatabase.inspectTable("public", "acceptance_scratchpad_transaction")).exists,
        )
        .toBe(false);
    });

    await test.step("roll back the active Transaction on extension shutdown", async () => {
      await workbench.scratchpads.setMode(scratchpad, "MANUAL");
      const shutdownWork = await notebook.addCodeCell();
      await notebook.typeInCell(
        shutdownWork,
        "CREATE TABLE public.acceptance_scratchpad_shutdown_rollback(id integer)",
      );
      await notebook.executeCode(shutdownWork);
      await expect(
        await workbench.scratchpads.transaction(scratchpad, "in progress"),
      ).toContainText("1 Statement");
      await vscode.executeCommand("workbench.action.files.saveAll");

      await vscode.executeInfrastructureCommand("workbench.action.reloadWindow");
      await expect
        .poll(
          async () =>
            (await demoDatabase.inspectTable("public", "acceptance_scratchpad_shutdown_rollback"))
              .exists,
        )
        .toBe(false);
      await workbench.ensureServer(demoConnectionUrl, server);
      await workbench.ensureDatabaseIndexed(server, database);
    });
  });

  test("creates Markdown notes and executes a PostgreSQL query", async ({
    workbench,
    notebook,
  }) => {
    await test.step("create a scratchpad from its Connexion", async () => {
      await workbench.ensureServer(demoConnectionUrl, server);
      await createScratchpad(workbench, notebook, demoAssociationText);
    });

    await test.step("add and render a real Markdown cell without SQL controls", async () => {
      const markdown = await notebook.addMarkdownCell();
      await expect(markdown).toHaveClass(/markdown-cell-row/);
      await expect(markdown).not.toContainText(demoAssociationText);
      await notebook.typeInCell(markdown, "# Acceptance notes");
      await expect
        .poll(() => notebook.snapshot(), { timeout: 5_000 })
        .toMatchObject({
          cells: [
            { kind: "code", languageId: "plpgsql" },
            {
              kind: "markup",
              languageId: "markdown",
              text: expect.stringMatching(/^# Acceptance notes\s*$/u),
            },
          ],
          notebookType: "postgresql-workbench-sql",
        });
      await notebook.renderMarkdown(markdown);
      const markdownFrame = await notebook.frameContainingText("Acceptance notes");
      await expect(markdownFrame.getByText("Acceptance notes", { exact: true })).toBeVisible({
        timeout: 5_000,
      });
    });

    await test.step("add a SQL cell and inspect its real PostgreSQL result", async () => {
      const code = await notebook.addCodeCell();
      await expect(code).not.toHaveClass(/markdown-cell-row/);
      await expect(code).toContainText(demoAssociationText);
      await notebook.typeInCell(
        code,
        "SELECT * FROM (VALUES (1, 'ready'), (2, 'verified')) AS result(id, status)",
      );
      await notebook.executeCode(code);

      await expect
        .poll(() => notebook.snapshot(), { timeout: 10_000 })
        .toMatchObject({
          cells: [
            { kind: "code", languageId: "plpgsql" },
            {
              kind: "markup",
              languageId: "markdown",
              text: expect.stringMatching(/^# Acceptance notes\s*$/u),
            },
            {
              kind: "code",
              languageId: "plpgsql",
              outputGroups: [expect.arrayContaining([resultMime])],
            },
          ],
        });
      const result = await notebook.resultFrame("verified");
      await expect(result.getByRole("region", { name: "PostgreSQL query result" })).toBeVisible();
      await expect(result.getByText("ready", { exact: true })).toBeVisible();
      await expect(result.getByText("verified", { exact: true })).toBeVisible();
    });
  });

  test("stacks only row-producing results from a multi-statement cell", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, demoAssociationText);
    const code = notebook.cell(0);
    await notebook.typeInCell(
      code,
      [
        "SELECT 1::integer AS sequence, 'first'::text AS state;",
        "CREATE TEMP TABLE acceptance_silent(id integer);",
        "INSERT INTO acceptance_silent VALUES (2);",
        "SELECT id AS sequence, 'second'::text AS state FROM acceptance_silent;",
        "SET application_name = 'postgresql-workbench-acceptance';",
      ].join("\n"),
    );
    await notebook.executeCode(code);

    await expect
      .poll(async () => (await notebook.snapshot())?.cells[0]?.outputGroups.length, {
        timeout: 10_000,
        message: "The multi-statement cell must expose exactly its two row-producing results",
      })
      .toBe(2);
    const snapshot = await notebook.snapshot();
    expect(snapshot?.cells[0]?.outputGroups).toHaveLength(2);
    for (const group of snapshot?.cells[0]?.outputGroups ?? []) expect(group).toContain(resultMime);

    const first = await notebook.frameContainingText("first");
    const second = await notebook.frameContainingText("second");
    await expect(first.getByText("first", { exact: true })).toBeVisible();
    await expect(second.getByText("second", { exact: true })).toBeVisible();
    expect(await notebook.renderedTextCount(/completed without a row set/i)).toBe(0);
  });

  test("executes a data-modifying CTE through the real notebook UI", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, demoAssociationText);
    const code = notebook.cell(0);
    await notebook.typeInCell(
      code,
      [
        "CREATE TEMP TABLE notebook_cursor_safety(id integer);",
        "WITH inserted AS (",
        "  INSERT INTO notebook_cursor_safety (id)",
        "  SELECT value FROM generate_series(1, 3) AS value",
        "  RETURNING id",
        ")",
        "SELECT id FROM inserted ORDER BY id;",
      ].join("\n"),
    );
    await notebook.executeCode(code);

    await expect
      .poll(async () => (await notebook.snapshot())?.cells[0]?.outputGroups.length, {
        timeout: 10_000,
        message: "The data-modifying CTE must expose its returned rows without opening a cursor",
      })
      .toBe(1);
    const result = await notebook.resultFrame("3");
    await expect(result.getByRole("region", { name: "PostgreSQL query result" })).toBeVisible();
    for (const id of ["1", "2", "3"]) {
      await expect(result.getByText(id, { exact: true })).toBeVisible();
    }
  });

  test("executes a wide SQL projection beyond the former parser budget", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, demoAssociationText);
    const code = notebook.cell(0);
    const projection = Array.from(
      { length: 64 },
      (_, index) => `  ${index + 1} AS projected_column_${index + 1}`,
    ).join(",\n");
    await notebook.typeInCell(code, `SELECT\n${projection};`);
    await notebook.executeCode(code);

    await expect
      .poll(async () => (await notebook.snapshot())?.cells[0]?.outputGroups, {
        timeout: 10_000,
        message: "The wide cell must execute instead of reporting a truncated syntax tree",
      })
      .toEqual([expect.arrayContaining([resultMime])]);
    const result = await notebook.frameContainingText("projected_column_64");
    await expect(result.getByRole("region", { name: "PostgreSQL query result" })).toBeVisible();
    await expect(result.getByText("projected_column_64", { exact: true })).toHaveCount(1);
  });

  test("pages and loads a large PostgreSQL result through the result controls", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, demoAssociationText);
    const code = notebook.cell(0);
    await notebook.typeInCell(code, "SELECT value FROM generate_series(1, 1000) AS value");
    await notebook.executeCode(code);

    const firstPage = await notebook.resultFrame("Rows 1–200 · more available");
    await expect(firstPage.getByText("Rows 1–200 · more available", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await firstPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(firstPage.getByText("Rows 201–400 · more available", { exact: true })).toBeVisible(
      {
        timeout: 5_000,
      },
    );
    await firstPage.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(firstPage.getByText("Rows 1–200 · more available", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await firstPage.getByRole("button", { name: "Load all", exact: true }).click();
    await expect(firstPage.getByText("1000 rows", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders syntax and PostgreSQL failures without internal stack traces", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, demoAssociationText);

    const syntaxCell = notebook.cell(0);
    await notebook.typeInCell(syntaxCell, "SELECT 1 + ;");
    await notebook.executeCode(syntaxCell);
    const syntaxFrame = await notebook.frameContainingText("SQL syntax error");
    const syntaxError = syntaxFrame.locator(".sql-error");
    await expect(syntaxError).toContainText("SQL syntax error");
    expect(await syntaxError.innerText()).not.toMatch(
      /\n\s*at\s|sqlNotebook\.(?:ts|js)|\/Users\//u,
    );

    const postgresCell = await notebook.addCodeCell();
    await notebook.typeInCell(
      postgresCell,
      "SELECT * FROM public.acceptance_table_that_does_not_exist",
    );
    await notebook.executeCode(postgresCell);
    const postgresFrame = await notebook.frameContainingText("PostgreSQL error");
    const postgresError = postgresFrame.locator(".sql-error").filter({
      hasText: "PostgreSQL error",
    });
    await expect(postgresError).toContainText("relation");
    await expect(postgresError).toContainText("42P01");
    expect(await postgresError.innerText()).not.toMatch(
      /\n\s*at\s|sqlNotebook\.(?:ts|js)|\/Users\//u,
    );
  });
});
