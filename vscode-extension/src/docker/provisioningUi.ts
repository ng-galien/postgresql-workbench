import * as vscode from "vscode";
import {
  DOCKER_DEBUGGER_VERSIONS,
  DockerDebuggerProvisioner,
  type DockerDebuggerVersion,
} from "../../../packages/dap/src/dockerDatabase.js";
import type { ConnectionManager } from "../connection/index.js";
import { ConnectionStore } from "../connection/index.js";

interface VersionItem extends vscode.QuickPickItem {
  version: DockerDebuggerVersion;
}

function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Enter a TCP port between 1 and 65535";
  }
  return undefined;
}

export async function startDockerDebugDatabase(
  cm: ConnectionManager,
  out: vscode.OutputChannel,
): Promise<string | undefined> {
  const version = await vscode.window.showQuickPick<VersionItem>(
    DOCKER_DEBUGGER_VERSIONS.map((candidate, index) => ({
      label: `PostgreSQL ${candidate}`,
      description: index === 0 ? "Recommended" : undefined,
      detail: `galien0xffffff/postgres-debugger:${candidate} · amd64/arm64`,
      version: candidate,
    })),
    {
      title: "Start a local PL/pgSQL debug database",
      placeHolder: "Choose a PostgreSQL version",
    },
  );
  if (!version) return undefined;

  const portText = await vscode.window.showInputBox({
    title: `PostgreSQL ${version.version} local port`,
    prompt: "The container is exposed only on 127.0.0.1",
    value: "5432",
    validateInput: validatePort,
    ignoreFocusOut: true,
  });
  if (portText === undefined) return undefined;
  const port = Number(portText);

  try {
    const provisioner = new DockerDebuggerProvisioner();
    const provisioned = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PostgreSQL Workbench: PostgreSQL ${version.version}`,
        cancellable: false,
      },
      async (progress) =>
        provisioner.start({ version: version.version, hostPort: port }, (message) => {
          out.appendLine(`docker: ${message}`);
          progress.report({ message });
        }),
    );

    const connection = {
      id: ConnectionStore.makeId(
        provisioned.host,
        provisioned.port,
        provisioned.database,
        provisioned.user,
      ),
      host: provisioned.host,
      port: provisioned.port,
      database: provisioned.database,
      user: provisioned.user,
    };
    await cm.store.add(connection, provisioned.password);
    const connected = await cm.connectConnection(connection.id);
    if (!connected) return undefined;

    vscode.window.showInformationMessage(
      `PostgreSQL ${version.version} is ready and connected on 127.0.0.1:${port}.`,
    );
    return connection.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.appendLine(`Docker setup failed: ${message}`);
    const action = await vscode.window.showErrorMessage(
      `Could not start the Docker debug database: ${message}`,
      "Show Logs",
    );
    if (action === "Show Logs") out.show();
    return undefined;
  }
}
