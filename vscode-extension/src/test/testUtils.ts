import * as net from "node:net";
import * as vscode from "vscode";

export const EXT_ID = "ng-galien.postgresql-workbench";

/** Launch config against the e2e PostgreSQL container (port 5433). */
export function pgConfig(sql: string, name = "Test"): vscode.DebugConfiguration {
  return {
    type: "postgresql-workbench",
    request: "launch",
    name,
    host: "localhost",
    port: 5433,
    database: "testdb",
    user: "postgres",
    password: "postgres",
    sql,
  };
}

export function pgAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "localhost", port: 5433 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Arm a listener for the next plpgsql session start. Call BEFORE triggering
 * the launch (command, startDebugging) and await the returned promise after.
 */
export function waitForSessionStart(timeoutMs = 15_000): Promise<vscode.DebugSession> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      d.dispose();
      reject(new Error("Session start timeout"));
    }, timeoutMs);
    const d = vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === "postgresql-workbench") {
        clearTimeout(timer);
        d.dispose();
        resolve(s);
      }
    });
  });
}

/** Start a plpgsql debug session from a launch config and return it. */
export async function startPlpgsqlSession(
  config: vscode.DebugConfiguration,
  timeoutMs = 15_000,
): Promise<vscode.DebugSession> {
  const started = waitForSessionStart(timeoutMs);
  const ok = await vscode.debug.startDebugging(undefined, config);
  if (!ok) {
    started.catch(() => {});
    throw new Error("startDebugging returned false");
  }
  return started;
}

/** Resolve when the current plpgsql session terminates. */
export function waitSessionEnd(timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      d.dispose();
      reject(new Error("Session did not terminate"));
    }, timeoutMs);
    const d = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.type === "postgresql-workbench") {
        clearTimeout(timer);
        d.dispose();
        resolve();
      }
    });
  });
}

/** Teardown helper: stop any lingering plpgsql session and wait for its end. */
export async function stopActivePlpgsqlSession(): Promise<void> {
  if (vscode.debug.activeDebugSession?.type === "postgresql-workbench") {
    const ended = waitSessionEnd();
    await vscode.debug.stopDebugging();
    await ended.catch(() => {});
  }
}
