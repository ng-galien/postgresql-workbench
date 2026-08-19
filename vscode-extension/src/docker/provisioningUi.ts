import * as vscode from "vscode";
import type { ConnectionManager } from "../connection/index.js";
import { ServerStore } from "../connection/index.js";
import {
  DOCKER_DEBUGGER_VERSIONS,
  DockerDebuggerProvisioner,
  type DockerDebuggerVersion,
} from "./provisioning.js";

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
    const connection = await vscode.window.withProgress(
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

    const server = {
      id: ServerStore.makeId(
        connection.host,
        connection.port,
        connection.database,
        connection.user,
      ),
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
    };
    await cm.store.add(server, connection.password);
    const connected = await cm.connectServer(server.id);
    if (!connected) return undefined;

    vscode.window.showInformationMessage(
      `PostgreSQL ${version.version} is ready and connected on 127.0.0.1:${port}.`,
    );
    return server.id;
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
