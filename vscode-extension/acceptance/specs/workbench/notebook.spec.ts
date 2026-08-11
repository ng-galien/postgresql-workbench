import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import type { NotebookPage } from "../../pages/NotebookPage";
import type { WorkbenchPage } from "../../pages/WorkbenchPage";

const server = /postgres@localhost:5434/;
const database = /^demo/;
const resultMime = "application/vnd.postgresql-workbench.sql-result+json";

async function createScratchpad(workbench: WorkbenchPage, notebook: NotebookPage): Promise<void> {
  await workbench.ensureServer(demoConnectionUrl, server);
  await workbench.tree.expandPath([server, database]);
  const scratchpads = workbench.tree.item(/^Scratchpads/);
  await scratchpads.hover();
  await scratchpads.getByLabel(/New SQL Scratchpad/i).click();
  await notebook.activateLatestScratchpad();
  await expect(notebook.cells).toHaveCount(1, { timeout: 5_000 });
  await expect(notebook.cell(0)).toContainText(/postgres@localhost:5434/);
}

test.describe("SQL notebook journeys", () => {
  test("creates Markdown notes and executes a PostgreSQL query", async ({
    workbench,
    notebook,
  }) => {
    await test.step("create a scratchpad from its database context", async () => {
      await createScratchpad(workbench, notebook);
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
            { kind: "markup", languageId: "markdown", text: "# Acceptance notes" },
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
            { kind: "markup", languageId: "markdown", text: "# Acceptance notes" },
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
    await createScratchpad(workbench, notebook);
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

  test("renders syntax and PostgreSQL failures without internal stack traces", async ({
    workbench,
    notebook,
  }) => {
    await createScratchpad(workbench, notebook);

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
