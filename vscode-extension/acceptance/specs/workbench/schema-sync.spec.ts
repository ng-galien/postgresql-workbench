import {
  demoDatabaseTreeItem as database,
  demoAssociationText,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";
import type { NotebookPage } from "../../pages/NotebookPage";
import type { WorkbenchPage } from "../../pages/WorkbenchPage";

const probe = /^ddl_sync_probe(?:\s|$)/;
const renamedProbe = /^ddl_sync_probe_renamed(?:\s|$)/;
const probeRoutine = /^ddl_sync_probe_touch\(\)/;
const probeTrigger = /^ddl_sync_probe_trigger(?:\s|$)/;

async function expectChildAtPath(
  workbench: WorkbenchPage,
  parentPath: RegExp[],
  child: RegExp,
  present: boolean,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const parent = await workbench.tree.expandPath(parentPath);
        return workbench.tree.hasChild(parent, child);
      },
      { timeout: 30_000 },
    )
    .toBe(present);
}

async function expectPublicChild(
  workbench: WorkbenchPage,
  child: RegExp,
  present: boolean,
): Promise<void> {
  await expectChildAtPath(workbench, [server, database, /^Sources/, /^public$/], child, present);
}

async function executeDdl(
  notebook: NotebookPage,
  sql: string,
  completionMarker: string,
): Promise<void> {
  const cell = await notebook.addCodeCell();
  await notebook.typeInCell(cell, `${sql};\nSELECT '${completionMarker}'::text AS ddl_state`);
  await notebook.executeCode(cell);
  const result = await notebook.frameContainingText(completionMarker);
  await expect(result.getByText(completionMarker, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Workbench schema synchronization", () => {
  test("keeps the visible TreeView aligned after CREATE, ALTER, and DROP", async ({
    demoDatabase,
    workbench,
    notebook,
  }) => {
    test.setTimeout(120_000);

    await test.step("require a clean PostgreSQL and TreeView baseline", async () => {
      expect(await demoDatabase.inspectSchemaSync("workbench")).toEqual({
        ddlFunction: false,
        ddlTrigger: false,
        dropFunction: false,
        dropTrigger: false,
      });
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe")).toEqual({
        columns: [],
        exists: false,
      });
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe_renamed")).toEqual({
        columns: [],
        exists: false,
      });
      expect(await demoDatabase.inspectRoutine("public", "ddl_sync_probe_touch")).toEqual({
        exists: false,
      });
      expect(
        await demoDatabase.inspectTrigger("public", "ddl_sync_probe", "ddl_sync_probe_trigger"),
      ).toEqual({ exists: false });
      await workbench.ensureServer(demoConnectionUrl, server);
    });

    await test.step("provision explicitly and resume the existing provisioning after opt-out", async () => {
      await workbench.enableAndProvisionSchemaSync(server, database);
      expect(await demoDatabase.inspectSchemaSync("workbench")).toEqual({
        ddlFunction: true,
        ddlTrigger: true,
        dropFunction: true,
        dropTrigger: true,
      });
      await workbench.restartSchemaSync(server, database);
    });

    await test.step("index public and execute DDL through a bound SQL scratchpad", async () => {
      await workbench.expectActiveDatabaseIndexed(server, database);
      await expectPublicChild(workbench, probe, false);
      await expectPublicChild(workbench, renamedProbe, false);
      await createScratchpad(workbench, notebook, demoAssociationText);
      await executeDdl(
        notebook,
        "CREATE TABLE public.ddl_sync_probe (id bigint PRIMARY KEY)",
        "created",
      );
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe")).toEqual({
        columns: ["id"],
        exists: true,
      });
    });

    await test.step("show the created table without rebuilding the full index", async () => {
      await expectPublicChild(workbench, probe, true);
    });

    await test.step("show an added column after ALTER TABLE", async () => {
      await executeDdl(
        notebook,
        "ALTER TABLE public.ddl_sync_probe ADD COLUMN note text",
        "altered",
      );
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe")).toEqual({
        columns: ["id", "note"],
        exists: true,
      });
      await expectChildAtPath(
        workbench,
        [server, database, /^Sources/, /^public$/, probe],
        /^note/,
        true,
      );
      const table = await workbench.tree.expandPath([
        server,
        database,
        /^Sources/,
        /^public$/,
        probe,
      ]);
      await expect(await workbench.tree.findChild(table, /^note/)).toHaveAccessibleName(
        /^note · text$/,
      );
      const sources = await workbench.tree.expandPath([server, database, /^Sources/]);
      await expect(sources).toContainText("available", {
        timeout: 5_000,
      });
    });

    await test.step("replace the old table identity after ALTER TABLE RENAME", async () => {
      await executeDdl(
        notebook,
        "ALTER TABLE public.ddl_sync_probe RENAME TO ddl_sync_probe_renamed",
        "renamed",
      );
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe")).toEqual({
        columns: [],
        exists: false,
      });
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe_renamed")).toEqual({
        columns: ["id", "note"],
        exists: true,
      });
      await expectPublicChild(workbench, probe, false);
      await expectPublicChild(workbench, renamedProbe, true);
      await expectChildAtPath(
        workbench,
        [server, database, /^Sources/, /^public$/, renamedProbe],
        /^note/,
        true,
      );
      const renamedTable = await workbench.tree.expandPath([
        server,
        database,
        /^Sources/,
        /^public$/,
        renamedProbe,
      ]);
      await expect(await workbench.tree.findChild(renamedTable, /^note/)).toHaveAccessibleName(
        /^note · text$/,
      );
    });

    await test.step("show a trigger and its function after committed DDL", async () => {
      await executeDdl(
        notebook,
        `CREATE FUNCTION public.ddl_sync_probe_touch() RETURNS trigger
         LANGUAGE plpgsql
         AS $$ BEGIN NEW.note := COALESCE(NEW.note, 'touched'); RETURN NEW; END $$`,
        "routine-created",
      );
      expect(await demoDatabase.inspectRoutine("public", "ddl_sync_probe_touch")).toEqual({
        exists: true,
      });
      await executeDdl(
        notebook,
        `CREATE TRIGGER ddl_sync_probe_trigger
         BEFORE INSERT ON public.ddl_sync_probe_renamed
         FOR EACH ROW EXECUTE FUNCTION public.ddl_sync_probe_touch()`,
        "trigger-created",
      );
      expect(
        await demoDatabase.inspectTrigger(
          "public",
          "ddl_sync_probe_renamed",
          "ddl_sync_probe_trigger",
        ),
      ).toEqual({ exists: true });
      await expectPublicChild(workbench, probeRoutine, true);
      await expectPublicChild(workbench, probeTrigger, true);
    });

    await test.step("remove the trigger and its function from PostgreSQL and the TreeView", async () => {
      await executeDdl(
        notebook,
        "DROP TRIGGER ddl_sync_probe_trigger ON public.ddl_sync_probe_renamed",
        "trigger-dropped",
      );
      expect(
        await demoDatabase.inspectTrigger(
          "public",
          "ddl_sync_probe_renamed",
          "ddl_sync_probe_trigger",
        ),
      ).toEqual({ exists: false });
      await expectPublicChild(workbench, probeTrigger, false);

      await executeDdl(notebook, "DROP FUNCTION public.ddl_sync_probe_touch()", "routine-dropped");
      expect(await demoDatabase.inspectRoutine("public", "ddl_sync_probe_touch")).toEqual({
        exists: false,
      });
      await expectPublicChild(workbench, probeRoutine, false);
    });

    await test.step("remove the table from the visible TreeView after DROP TABLE", async () => {
      await executeDdl(notebook, "DROP TABLE public.ddl_sync_probe_renamed", "dropped");
      expect(await demoDatabase.inspectTable("public", "ddl_sync_probe_renamed")).toEqual({
        columns: [],
        exists: false,
      });
      await expectPublicChild(workbench, renamedProbe, false);
    });

    await test.step("remove the test provisioning and leave synchronization disabled", async () => {
      await workbench.removeAndDisableSchemaSync(server, database);
      expect(await demoDatabase.inspectSchemaSync("workbench")).toEqual({
        ddlFunction: false,
        ddlTrigger: false,
        dropFunction: false,
        dropTrigger: false,
      });
    });
  });
});
