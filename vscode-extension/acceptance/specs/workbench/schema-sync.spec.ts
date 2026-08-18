import {
  demoDatabaseTreeItem as database,
  demoAssociationText,
  demoConnectionId,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import type { VSCodeInstance, WorkbenchStateSnapshot } from "../../fixtures/vscode";
import { createScratchpad } from "../../journeys/scratchpad";
import type { NotebookPage } from "../../pages/NotebookPage";
import type { WorkbenchPage } from "../../pages/WorkbenchPage";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

const probe = /^ddl_sync_probe(?:\s|$)/;
const renamedProbe = /^ddl_sync_probe_renamed(?:\s|$)/;
const probeRoutine = /^ddl_sync_probe_touch\(\)/;
const probeTrigger = /^ddl_sync_probe_trigger(?:\s|$)/;

interface SchemaSyncCheckpoint {
  eventSequence: number;
  generation: number;
  transactionId?: string;
}

function schemaSyncState(snapshot: WorkbenchStateSnapshot) {
  return snapshot.schemaSync.find(({ serverId }) => serverId === demoConnectionId);
}

async function expectSchemaSyncQuiescent(
  vscode: VSCodeInstance,
): Promise<{ checkpoint: SchemaSyncCheckpoint; snapshot: WorkbenchStateSnapshot }> {
  let snapshot: WorkbenchStateSnapshot | undefined;
  await expect
    .poll(
      async () => {
        snapshot = await vscode.inspectWorkbenchState();
        const sync = schemaSyncState(snapshot);
        const exactIndex = snapshot.index.states.find(
          (state) => state.result?.serverId === demoConnectionId,
        );
        const result = exactIndex?.result;
        return Boolean(
          snapshot.connection.connected &&
            snapshot.connection.connectedServerIds.includes(demoConnectionId) &&
            sync?.desired?.enabled &&
            sync.state.status === "listening" &&
            typeof sync.listener?.processId === "number" &&
            sync.listener.queuedNotifications === 0 &&
            !sync.listener.flushScheduled &&
            !sync.listener.flushActive &&
            !sync.lifecycle.active &&
            !sync.lifecycle.starting &&
            !sync.lifecycle.reconnectScheduled &&
            sync.lifecycle.queued === 0 &&
            !sync.refresh.active &&
            sync.refresh.queued === 0 &&
            exactIndex?.status === "available" &&
            result?.serverId === demoConnectionId &&
            typeof result.generation === "number" &&
            !snapshot.index.activeRun &&
            !snapshot.index.currentRunPending &&
            snapshot.index.sourceMutationsActive === 0,
        );
      },
      {
        timeout: 30_000,
        message: "Schema Sync listener, notification drain, and exact index must be quiescent",
      },
    )
    .toBe(true);

  const result = snapshot?.index.states.find(
    (state) => state.result?.serverId === demoConnectionId,
  )?.result;
  if (!snapshot || typeof result?.generation !== "number") {
    throw new Error(`Schema Sync checkpoint is incomplete: ${JSON.stringify(snapshot)}`);
  }
  return {
    checkpoint: {
      eventSequence: snapshot.index.events.at(-1)?.sequence ?? 0,
      generation: result.generation,
      transactionId: schemaSyncState(snapshot)?.lastReceivedTransactionId,
    },
    snapshot,
  };
}

async function expectIncrementalDdlRefresh(
  vscode: VSCodeInstance,
  before: SchemaSyncCheckpoint,
): Promise<WorkbenchStateSnapshot> {
  let snapshot: WorkbenchStateSnapshot | undefined;
  await expect
    .poll(
      async () => {
        snapshot = await vscode.inspectWorkbenchState();
        const sync = schemaSyncState(snapshot);
        const exactIndex = snapshot.index.states.find(
          (state) => state.result?.serverId === demoConnectionId,
        );
        const result = exactIndex?.result;
        const matchingPublication = snapshot.index.events.some(
          (event) =>
            event.sequence > before.eventSequence &&
            event.status === "available" &&
            event.changeKind === "incremental" &&
            typeof event.generation === "number" &&
            event.generation > before.generation,
        );
        return Boolean(
          sync?.state.status === "listening" &&
            sync.lastReceivedTransactionId &&
            sync.lastReceivedTransactionId !== before.transactionId &&
            sync.lastCompletedTransactionId === sync.lastReceivedTransactionId &&
            sync.listener?.queuedNotifications === 0 &&
            !sync.listener.flushScheduled &&
            !sync.listener.flushActive &&
            !sync.lifecycle.active &&
            !sync.lifecycle.starting &&
            !sync.lifecycle.reconnectScheduled &&
            sync.lifecycle.queued === 0 &&
            !sync.refresh.active &&
            sync.refresh.queued === 0 &&
            exactIndex?.status === "available" &&
            typeof result?.generation === "number" &&
            result.generation > before.generation &&
            !snapshot.index.activeRun &&
            !snapshot.index.currentRunPending &&
            snapshot.index.sourceMutationsActive === 0 &&
            matchingPublication,
        );
      },
      {
        timeout: 30_000,
        message:
          "The committed DDL transaction must be received, incrementally published, and fully drained",
      },
    )
    .toBe(true);

  if (!snapshot) throw new Error("Schema Sync completed without an acceptance snapshot");
  expect(
    snapshot.index.events.some(
      (event) => event.sequence > before.eventSequence && event.changeKind === "full",
    ),
    "Business DDL must not silently fall back to a full index rebuild",
  ).toBe(false);
  return snapshot;
}

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
  await expectChildAtPath(
    workbench,
    [server, database, SCHEMAS_TREE_ITEM, /^public$/],
    child,
    present,
  );
}

async function executeDdl(
  vscode: VSCodeInstance,
  notebook: NotebookPage,
  sql: string,
  completionMarker: string,
): Promise<void> {
  const { checkpoint } = await expectSchemaSyncQuiescent(vscode);
  const cell = await notebook.addCodeCell();
  await notebook.typeInCell(cell, `${sql};\nSELECT '${completionMarker}'::text AS ddl_state`);
  await notebook.executeCode(cell);
  const result = await notebook.frameContainingText(completionMarker);
  await expect(result.getByText(completionMarker, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expectIncrementalDdlRefresh(vscode, checkpoint);
}

test.describe("Workbench schema synchronization", () => {
  test("keeps the visible TreeView aligned after CREATE, ALTER, and DROP", async ({
    demoDatabase,
    workbench,
    notebook,
    vscode,
  }) => {
    test.setTimeout(150_000);

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
      // Provisioning itself is structural DDL and intentionally invalidates the
      // pre-provisioning snapshot. Rebuild once, then every business DDL below
      // must advance this baseline incrementally.
      await workbench.ensureDatabaseIndexed(server, database);
      await workbench.restartSchemaSync(server, database);
      await expectSchemaSyncQuiescent(vscode);
    });

    await test.step("index public and execute DDL through a bound SQL scratchpad", async () => {
      await expectPublicChild(workbench, probe, false);
      await expectPublicChild(workbench, renamedProbe, false);
      await createScratchpad(workbench, notebook, demoAssociationText);
      await executeDdl(
        vscode,
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
        vscode,
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
        [server, database, SCHEMAS_TREE_ITEM, /^public$/, probe],
        /^note/,
        true,
      );
      const table = await workbench.tree.expandPath([
        server,
        database,
        SCHEMAS_TREE_ITEM,
        /^public$/,
        probe,
      ]);
      await expect(await workbench.tree.findChild(table, /^note/)).toHaveAccessibleName(
        /^note · text$/,
      );
    });

    await test.step("replace the old table identity after ALTER TABLE RENAME", async () => {
      await executeDdl(
        vscode,
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
        [server, database, SCHEMAS_TREE_ITEM, /^public$/, renamedProbe],
        /^note/,
        true,
      );
      const renamedTable = await workbench.tree.expandPath([
        server,
        database,
        SCHEMAS_TREE_ITEM,
        /^public$/,
        renamedProbe,
      ]);
      await expect(await workbench.tree.findChild(renamedTable, /^note/)).toHaveAccessibleName(
        /^note · text$/,
      );
    });

    await test.step("show a trigger and its function after committed DDL", async () => {
      await executeDdl(
        vscode,
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
        vscode,
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
        vscode,
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

      await executeDdl(
        vscode,
        notebook,
        "DROP FUNCTION public.ddl_sync_probe_touch()",
        "routine-dropped",
      );
      expect(await demoDatabase.inspectRoutine("public", "ddl_sync_probe_touch")).toEqual({
        exists: false,
      });
      await expectPublicChild(workbench, probeRoutine, false);
    });

    await test.step("remove the table from the visible TreeView after DROP TABLE", async () => {
      await executeDdl(vscode, notebook, "DROP TABLE public.ddl_sync_probe_renamed", "dropped");
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
