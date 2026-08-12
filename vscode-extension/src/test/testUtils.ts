import * as vscode from "vscode";

export const EXT_ID = "ng-galien.postgresql-workbench";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForSessionStart(timeoutMs = 15_000): Promise<vscode.DebugSession> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Session start timeout"));
    }, timeoutMs);
    const subscription = vscode.debug.onDidStartDebugSession((session) => {
      if (session.type !== "postgresql-workbench") return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(session);
    });
  });
}

export async function stopActivePlpgsqlSession(): Promise<void> {
  if (vscode.debug.activeDebugSession?.type !== "postgresql-workbench") return;
  await vscode.debug.stopDebugging();
}
