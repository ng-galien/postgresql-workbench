import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type * as vscode from "vscode";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { type IWebSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc";
import { type WebSocket, WebSocketServer } from "ws";
import type { SqlAuthoringHostServices } from "../../packages/sql/src/languageServer/hostServices.js";
import { startSqlAuthoringServer } from "../../packages/sql/src/languageServer/sqlAuthoringServer.js";

/**
 * VS Code transport for Monaco's official language client. Language behavior stays in packages/sql;
 * this adapter owns only a loopback WebSocket and one LSP session per webview connection.
 */
export class SqlAuthoringWebviewServer implements vscode.Disposable {
  private readonly token = randomBytes(24).toString("base64url");
  private readonly sockets = new Set<WebSocket>();
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private server?: Server;
  private endpoint?: string;

  constructor(private readonly host: SqlAuthoringHostServices) {}

  async start(): Promise<void> {
    if (this.endpoint) return;
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path !== `/${this.token}`) {
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSockets.emit("connection", webSocket, request);
      });
    });
    this.webSockets.on("connection", (socket) => this.openSession(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("The SQL authoring webview endpoint did not receive a loopback port.");
    }
    this.server = server;
    this.endpoint = `ws://127.0.0.1:${address.port}/${this.token}`;
  }

  url(): string {
    if (!this.endpoint) throw new Error("The SQL authoring webview endpoint is not running.");
    return this.endpoint;
  }

  dispose(): void {
    this.endpoint = undefined;
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.webSockets.close();
    this.server?.close();
    this.server = undefined;
  }

  private openSession(socket: WebSocket): void {
    this.sockets.add(socket);
    const webSocket: IWebSocket = {
      send: (content) => socket.send(content),
      onMessage: (listener) => socket.on("message", (data) => listener(data.toString())),
      onError: (listener) => socket.on("error", listener),
      onClose: (listener) =>
        socket.on("close", (code, reason) => listener(code, reason.toString())),
      dispose: () => socket.close(),
    };
    const reader = new WebSocketMessageReader(webSocket);
    const writer = new WebSocketMessageWriter(webSocket);
    const connection = createConnection(ProposedFeatures.all, reader, writer);
    const session = startSqlAuthoringServer(connection, this.host);
    reader.onClose(() => {
      this.sockets.delete(socket);
      session.dispose();
      connection.dispose();
    });
  }
}
