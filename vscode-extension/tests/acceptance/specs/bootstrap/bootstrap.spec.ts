import { expect, test } from "../../fixtures/bootstrapTest";
import {
  demoConnectionTreeItem as connection,
  connectionTreeItem,
  demoDatabaseTreeItem as database,
  demoConnectionId,
  demoConnectionUrl,
  loopbackConnectionId,
  loopbackConnectionTreeItem,
} from "../../fixtures/demoDatabase";
import type { VSCodeInstance } from "../../fixtures/vscode";
import { startWorkbench } from "../../journeys/startup";
import { CONNECTED_TEXT, type WorkbenchPage } from "../../pages/WorkbenchPage";

const INVALID_CONNECTION_URL = "postgresql://postgres:postgres@127.0.0.1:59999/demo";
const INVALID_CONNECTION_ID = "127.0.0.1:59999/demo:postgres";
const INVALID_CONNECTION = connectionTreeItem("postgres@127.0.0.1:59999/demo");
const RENAMED_CONNECTION = connectionTreeItem("Demo recovery");
const CONNECTION_ERROR_NOTIFICATION =
  /^Error: postgres@127\.0\.0\.1:59999\/demo: Connection refused\./u;
const CONNECTION_PROGRESS_NOTIFICATION =
  /^Info: Connecting to postgres@127\.0\.0\.1:59999\/demo\.\.\./u;

function startConnectionAction(
  vscode: VSCodeInstance,
  connectionId: string,
  action: "Edit Connection" | "Rename Connection" | "Remove Connection",
): Promise<void> {
  const commands = {
    "Edit Connection": "postgresql-workbench.editConnection",
    "Remove Connection": "postgresql-workbench.removeConnection",
    "Rename Connection": "postgresql-workbench.renameConnection",
  } as const;
  return vscode.executeCommand(commands[action], 5_000, [{ connection: { id: connectionId } }]);
}

async function expectFailedConnection(workbench: WorkbenchPage) {
  const failure = workbench.page
    .getByRole("dialog", { name: CONNECTION_ERROR_NOTIFICATION })
    .last();
  await expect(failure).toBeVisible({ timeout: 5_000 });
  await expect(
    workbench.page.getByRole("dialog", { name: CONNECTION_PROGRESS_NOTIFICATION }),
  ).toBeHidden();
  return failure;
}

async function addInvalidConnection(workbench: WorkbenchPage) {
  await workbench.addConnection(INVALID_CONNECTION_URL, INVALID_CONNECTION, /disconnected/u);
}

async function confirmConnectionRemoval(workbench: WorkbenchPage) {
  const remove = workbench.confirmation("Remove");
  await expect(remove).toBeVisible({ timeout: 5_000 });
  await remove.click();
}

/**
 * The startup sequence, in the order a first-time workbench lives it. A VS Code instance that is
 * restarted keeps what this establishes, which is why every other lane may assume it.
 */
test("starts, configures its first Connection, and indexes the database behind it", async ({
  vscode,
  workbench,
}) => {
  await test.step("open the extension and its view", async () => {
    await expect(
      vscode.page.getByLabel("PostgreSQL Workbench", { exact: true }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  await test.step("start with no Connection configured, and open centralized management", async () => {
    const state = await vscode.inspectWorkbenchState();
    expect(state.connection.connectedConnectionIds).toEqual([]);
    await expect(vscode.page.getByText("Start a local debug database with Docker")).toHaveCount(0);
    await expect(
      vscode.page.getByRole("button", { name: "Open Connections", exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  });

  await test.step("live the startup sequence every other lane depends on", async () => {
    // The very sequence the fixtures run: this scenario is what proves it works from nothing.
    await startWorkbench(workbench, vscode.inspectWorkbenchState, {
      connectionUrl: demoConnectionUrl,
      connectionId: demoConnectionId,
      connection: connection,
      database,
    });
  });

  await test.step("leave a connected Connection and a published index behind", async () => {
    const state = await vscode.inspectWorkbenchState();
    expect(state.connection.connectedConnectionIds).toContain(demoConnectionId);
    const runtime = await workbench.expectFreshIndexRuntime({
      database,
      connectionId: demoConnectionId,
    });
    expect(runtime.connectionId).toBe(demoConnectionId);
  });
});

test("recovers, renames, and removes a Connection after connection errors", async ({
  vscode,
  workbench,
}) => {
  await workbench.reset();

  await test.step("remove an invalid Connection directly from its error state", async () => {
    await addInvalidConnection(workbench);
    const failure = await expectFailedConnection(workbench);
    const removal = startConnectionAction(vscode, INVALID_CONNECTION_ID, "Remove Connection");
    await confirmConnectionRemoval(workbench);
    await removal;
    await workbench.tree.expectItemAbsent(INVALID_CONNECTION);
    await expect(failure).toBeHidden();
  });

  await test.step("recreate the invalid Connection and expose recovery", async () => {
    await addInvalidConnection(workbench);
    const failure = await expectFailedConnection(workbench);
    await failure.getByRole("button", { name: "Edit Connection", exact: true }).click();
  });

  await test.step("correct the port and connect the edited Connection", async () => {
    await workbench.quickInput.chooseThenInput(/^Port/u);
    await expect(workbench.page.locator(".quick-input-widget:visible")).toContainText(/New Port/i);
    await workbench.quickInput.submit("5434");
    await expect(await workbench.tree.waitForItem(loopbackConnectionTreeItem)).toContainText(
      CONNECTED_TEXT,
      { timeout: 10_000 },
    );
    expect((await vscode.inspectWorkbenchState()).connection.connectedConnectionIds).toContain(
      loopbackConnectionId,
    );
  });

  await test.step("edit the working Connection back to an invalid port", async () => {
    const editing = startConnectionAction(vscode, loopbackConnectionId, "Edit Connection");
    await workbench.quickInput.chooseThenInput(/^Port/u);
    await expect(workbench.page.locator(".quick-input-widget:visible")).toContainText(/New Port/i);
    await workbench.quickInput.submit("59999");
    await editing;

    await expect(await workbench.tree.waitForItem(INVALID_CONNECTION)).toContainText(
      /disconnected/u,
      { timeout: 5_000 },
    );
    await expect(
      workbench.page.getByRole("dialog", { name: CONNECTION_PROGRESS_NOTIFICATION }),
    ).toBeHidden();
    expect((await vscode.inspectWorkbenchState()).connection.connectedConnectionIds).not.toContain(
      loopbackConnectionId,
    );
  });

  await test.step("rename and remove the failed Connection", async () => {
    const renaming = startConnectionAction(vscode, INVALID_CONNECTION_ID, "Rename Connection");
    await expect(workbench.page.locator(".quick-input-widget:visible")).toContainText(
      /Connection name/i,
    );
    await workbench.quickInput.submit("Demo recovery");
    await renaming;
    await expect(await workbench.tree.waitForItem(RENAMED_CONNECTION)).toContainText(
      /disconnected/u,
    );

    const removal = startConnectionAction(vscode, INVALID_CONNECTION_ID, "Remove Connection");
    await confirmConnectionRemoval(workbench);
    await removal;
    await workbench.tree.expectItemAbsent(RENAMED_CONNECTION);
    await expect(
      workbench.page.getByRole("dialog", { name: CONNECTION_ERROR_NOTIFICATION }),
    ).toBeHidden();
  });
});

test("restores the Connections setup action after removing the last Connection", async ({
  vscode,
  workbench,
}) => {
  await workbench.ensureConnection(demoConnectionUrl, connection);

  const removal = startConnectionAction(vscode, demoConnectionId, "Remove Connection");
  await confirmConnectionRemoval(workbench);
  await removal;

  await expect(
    vscode.page.getByRole("button", { name: "Open Connections", exact: true }),
  ).toBeVisible({ timeout: 5_000 });
});
