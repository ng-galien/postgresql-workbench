import { type ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  installProjectConfiguration,
  type McpClient,
  readProjectConfiguration,
} from "../../../packages/mcp/src/projectConfiguration.js";
import type { McpSettingsState } from "../../../packages/views/src/connections/protocol.js";
import type { ConnectionStore } from "./savedConnections.js";

/** VS Code owns controls and secret lookup; the child owns an independent Workbench runtime. */
export class McpIntegration implements vscode.Disposable {
  private child?: ChildProcess;
  private status: McpSettingsState["status"] = "Stopped";
  private message?: string;
  private busy = false;
  private disposed = false;
  private activeConnection?: string;
  private tokenPromise?: Promise<string>;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onChanged = this.changes.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
  ) {}

  private get port() {
    return this.context.workspaceState.get<number>("mcp.port", 7432);
  }
  private get url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }
  private get root() {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0]?.uri.scheme === "file"
      ? folders[0].uri.fsPath
      : undefined;
  }
  private get tokenKey() {
    return `postgresql-workbench.mcp.${this.root}`;
  }
  private token() {
    this.tokenPromise ??= (async () => {
      const token =
        (await this.context.secrets.get(this.tokenKey)) ?? randomBytes(32).toString("hex");
      await this.context.secrets.store(this.tokenKey, token);
      return token;
    })().catch((error) => {
      this.tokenPromise = undefined;
      throw error;
    });
    return this.tokenPromise;
  }

  async state(): Promise<McpSettingsState> {
    const root = this.root;
    const token = root ? ((await this.context.secrets.get(this.tokenKey)) ?? "") : "";
    return {
      status: this.status,
      busy: this.busy,
      port: this.port,
      url: this.url,
      ...(this.activeConnection ? { activeConnection: this.activeConnection } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.message ? { message: this.message } : {}),
      ...(root ? { project: root } : {}),
      trusted: vscode.workspace.isTrusted,
      integrations: root
        ? await Promise.all(
            (["codex", "claude"] as const).map((client) =>
              readProjectConfiguration(root, client, this.url, token),
            ),
          )
        : [],
    };
  }

  async act(
    action: "start" | "stop" | "port" | "install" | "refresh",
    port?: number,
    connectionId?: string,
    client?: McpClient,
  ) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.message = undefined;
    this.changes.fire();
    try {
      if (action !== "refresh" && action !== "stop" && (!vscode.workspace.isTrusted || !this.root))
        throw new Error("Open one trusted local project folder to manage MCP.");
      if (action === "stop") await this.stop();
      else if (action === "port") {
        if (this.child) throw new Error("Stop the MCP server before changing its port.");
        if (!Number.isInteger(port) || port! < 1024 || port! > 65535)
          throw new Error("Choose a port between 1024 and 65535.");
        await this.context.workspaceState.update("mcp.port", port);
      } else if (action === "install") {
        if (client !== "codex" && client !== "claude") throw new Error("Unknown MCP client.");
        await installProjectConfiguration(this.root!, client, this.url, await this.token());
      } else if (action === "start") {
        if (this.child) return;
        const config = this.store.get(connectionId ?? "");
        if (!config) throw new Error("Choose a saved PostgreSQL Connection for MCP.");
        const token = await this.token();
        const password = (await this.store.getPassword(config.id)) ?? "";
        if (this.disposed) return;
        this.status = "Starting";
        this.changes.fire();
        const child = fork(
          vscode.Uri.joinPath(this.context.extensionUri, "dist", "mcp-server.js").fsPath,
          [],
          {
            execArgv: [],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
        this.child = child;
        child.once("exit", () => {
          if (this.child === child) {
            this.child = undefined;
            this.status = "Failed";
            this.message = "MCP server exited. Start it again to create new sessions.";
            this.changes.fire();
          }
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("MCP startup timed out.")), 15_000);
            const finish = (error?: Error) => {
              clearTimeout(timer);
              child.off("exit", exited);
              child.off("error", finish);
              error ? reject(error) : resolve();
            };
            const exited = () => finish(new Error("MCP server exited during startup."));
            child.once("exit", exited);
            child.once("error", finish);
            child.once("message", (reply: { type: string; message?: string }) =>
              finish(
                reply.type === "ready"
                  ? undefined
                  : new Error(reply.message ?? "MCP startup failed."),
              ),
            );
            child.send({
              port: this.port,
              token,
              syntaxRuntimePath: vscode.Uri.joinPath(
                this.context.extensionUri,
                "runtime",
                "code-moniker",
              ).fsPath,
              profiles: [
                {
                  id: config.id,
                  label: config.name ?? config.database,
                  identity: { ...config, password },
                },
              ],
            });
          });
          this.status = "Running";
          this.activeConnection =
            config.name ?? `${config.user}@${config.host}:${config.port}/${config.database}`;
        } catch (error) {
          await this.stop();
          this.status = "Failed";
          throw error;
        }
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : "MCP operation failed.";
    } finally {
      this.busy = false;
      this.changes.fire();
    }
  }

  private async stop() {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.status = "Stopping";
      this.changes.fire();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (child.connected) child.disconnect();
        else child.kill("SIGTERM");
      });
    }
    this.status = "Stopped";
    this.activeConnection = undefined;
  }

  dispose() {
    this.disposed = true;
    void this.stop();
    this.changes.dispose();
  }
}
