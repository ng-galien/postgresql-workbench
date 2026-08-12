import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";

const server = /postgres@localhost:5434/;
const database = /^demo/;
const resultMime = "application/vnd.postgresql-workbench.sql-result+json";

test.describe("SQL notebook journeys", () => {
  test("creates Markdown notes and executes a PostgreSQL query", async ({
    workbench,
    notebook,
  }) => {
    await test.step("create a scratchpad from its database context", async () => {
      await workbench.ensureServer(demoConnectionUrl, server);
      await createScratchpad(workbench, notebook, server, database);
    });

    await test.step("add and render a real Markdown cell without SQL controls", async () => {
      const markdown = await notebook.addMarkdownCell();
      await expect(markdown).toHaveClass(/markdown-cell-row/);
      await expect(markdown).not.toContainText(/postgres@localhost:5434/);
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
      await expect(code).toContainText(/postgres@localhost:5434/);
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
      const result = await notebook.resultFrame();
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
    await createScratchpad(workbench, notebook, server, database);
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
    await createScratchpad(workbench, notebook, server, database);
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
    const result = await notebook.resultFrame();
    await expect(result.getByRole("region", { name: "PostgreSQL query result" })).toBeVisible();
    for (const id of ["1", "2", "3"]) {
      await expect(result.getByText(id, { exact: true })).toBeVisible();
    }
  });

  test("pages and loads a large PostgreSQL result through the result controls", async ({
    workbench,
    notebook,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await createScratchpad(workbench, notebook, server, database);
    const code = notebook.cell(0);
    await notebook.typeInCell(code, "SELECT value FROM generate_series(1, 1000) AS value");
    await notebook.executeCode(code);

    const firstPage = await notebook.resultFrame();
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
    await createScratchpad(workbench, notebook, server, database);

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
