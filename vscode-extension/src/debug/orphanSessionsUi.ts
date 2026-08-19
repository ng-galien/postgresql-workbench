import * as vscode from "vscode";
import type { DebugSessionStatus } from "../../../packages/dap/src/debugger/launch/debugSessionStatus.js";
import {
  type DebugSessionInfo,
  debugBackendSelections,
  enrichDebugSessions,
  listDebugSessions,
  terminateDebugSessions,
} from "../../../packages/dap/src/orphanSessions.js";
import type { ConnectionManager } from "../connection/index.js";
import { getConnectionName } from "../connection/index.js";

interface RefreshableTree {
  refresh(): void;
}

interface DebugSessionPickItem extends vscode.QuickPickItem {
  session: DebugSessionInfo;
}

function formatAge(startedAt: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function backendDetail(session: DebugSessionInfo): string {
  return session.backends
    .map((backend) => {
      const wait = backend.waitEvent ? `, ${backend.waitEvent}` : "";
      const client = backend.clientAddress ? `@${backend.clientAddress}` : "";
      const changed = backend.stateChangedAt
        ? `, changed ${formatAge(backend.stateChangedAt)} ago`
        : "";
      return `${backend.role} #${backend.pid}: ${backend.user}${client}, ${backend.state}${wait}${changed}`;
    })
    .join(" · ");
}

function sessionDescription(session: DebugSessionInfo): string {
  const roles = new Set(session.backends.map((backend) => backend.role));
  const incomplete = roles.size < 2 ? "incomplete · " : "";
  const foreign = session.backends.some((backend) => !backend.ownedByCurrentUser)
    ? "other role · "
    : "";
  const source = session.stateSource === "adapter" ? "" : " (database-inferred)";
  return `${session.state}${source} · ${incomplete}${foreign}${session.backends.length} backend${session.backends.length === 1 ? "" : "s"} · ${formatAge(session.startedAt)}`;
}

function sessionLabel(session: DebugSessionInfo): string {
  if (!session.routine) {
    return `$(debug-alt) Debug session ${session.id}${session.routineOid ? ` · OID ${session.routineOid}` : ""}`;
  }
  const routine = session.routine.schema
    ? `${session.routine.schema}.${session.routine.name}`
    : session.routine.name;
  return `$(debug-alt) ${routine} · OID ${session.routine.oid}`;
}

function sessionDetail(session: DebugSessionInfo): string {
  const query = session.query ? `query: ${session.query.slice(0, 180)} · ` : "";
  return `${query}adapter session ${session.id} · ${backendDetail(session)}`;
}

export async function manageDebugSessions(
  cm: ConnectionManager,
  treeProvider: RefreshableTree,
  out: vscode.OutputChannel,
  statuses: () => readonly DebugSessionStatus[] = () => [],
): Promise<void> {
  let server =
    cm.connectedServerIds.length === 1 ? cm.store.get(cm.connectedServerIds[0]) : undefined;
  if (!server && cm.connectedServerIds.length > 1) {
    const picked = await vscode.window.showQuickPick(
      cm.connectedServerIds.flatMap((id) => {
        const candidate = cm.store.get(id);
        return candidate ? [{ label: getConnectionName(candidate), server: candidate }] : [];
      }),
      { placeHolder: "Select the Connexion whose debug sessions you want to manage" },
    );
    server = picked?.server;
  }
  if (!server) {
    vscode.window.showInformationMessage("Connect to a PostgreSQL server first.");
    return;
  }
  const client = cm.getClient(server.id);
  if (!client) return;

  let sessions: DebugSessionInfo[];
  try {
    sessions = enrichDebugSessions(await listDebugSessions(client), statuses());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.appendLine(`Failed to list debug sessions: ${message}`);
    vscode.window.showErrorMessage(`Failed to list debug sessions: ${message}`);
    return;
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage(
      `${getConnectionName(server)}: no PL/pgSQL debug sessions found.`,
    );
    treeProvider.refresh();
    return;
  }

  const picked = await vscode.window.showQuickPick<DebugSessionPickItem>(
    sessions.map((session) => ({
      label: sessionLabel(session),
      description: sessionDescription(session),
      detail: sessionDetail(session),
      session,
    })),
    {
      canPickMany: true,
      ignoreFocusOut: true,
      placeHolder: "Select stale or blocked debug sessions to terminate",
      title: `${getConnectionName(server)} — Debug session recovery`,
    },
  );
  if (!picked || picked.length === 0) return;

  const backendCount = picked.reduce((total, item) => total + item.session.backends.length, 0);
  const includesForeignRole = picked.some((item) =>
    item.session.backends.some((backend) => !backend.ownedByCurrentUser),
  );
  const ownershipWarning = includesForeignRole
    ? " Some selected backends belong to another PostgreSQL role."
    : "";
  const confirm = await vscode.window.showWarningMessage(
    `Terminate ${picked.length} debug session${picked.length === 1 ? "" : "s"} (${backendCount} PostgreSQL backend${backendCount === 1 ? "" : "s"})? This also stops a session that is still live.${ownershipWarning}`,
    { modal: true },
    "Terminate",
  );
  if (confirm !== "Terminate") return;

  try {
    const terminations = await terminateDebugSessions(
      client,
      debugBackendSelections(picked.map((item) => item.session)),
    );
    const terminated = terminations.filter((result) => result.status === "terminated");
    const requested = terminations.filter((result) => result.status === "terminationRequested");
    const alreadyGone = terminations.filter((result) => result.status === "alreadyGone");
    const failed = terminations.filter(
      (result) => result.status === "denied" || result.status === "failed",
    );
    out.appendLine(
      `Debug session recovery: ${terminated.length} terminated, ${requested.length} requested, ${alreadyGone.length} already gone, ${failed.length} failed; terminated PIDs: ${terminated.map((result) => result.pid).join(", ")}`,
    );
    if (failed.length > 0 || requested.length > 0) {
      vscode.window.showWarningMessage(
        `${terminated.length} debug backend${terminated.length === 1 ? "" : "s"} terminated; ${requested.length} termination pending; ${alreadyGone.length} already gone; ${failed.length} could not be terminated.`,
      );
    } else if (terminated.length === 0) {
      vscode.window.showInformationMessage("The selected debug sessions had already ended.");
    } else {
      vscode.window.showInformationMessage(
        `${terminated.length} debug backend${terminated.length === 1 ? "" : "s"} terminated${alreadyGone.length > 0 ? `; ${alreadyGone.length} already gone` : ""}.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.appendLine(`Failed to terminate debug sessions: ${message}`);
    vscode.window.showErrorMessage(`Failed to terminate debug sessions: ${message}`);
  } finally {
    treeProvider.refresh();
  }
}
