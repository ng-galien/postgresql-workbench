import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { type IWebSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc";
import type { SqlAuthoringHostServices } from "../../sql/src/languageServer/hostServices.js";
import { startSqlAuthoringServer } from "../../sql/src/languageServer/sqlAuthoringServer.js";

/** The small part of `ws` the shell transport consumes. */
export interface ShellWebSocket {
  send(content: string): void;
  close(): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: { toString(): string }) => void): void;
}

/**
 * Opens one complete LSP session on one browser WebSocket. This adapter translates only transport
 * events; parser, context and language behavior remain behind SqlAuthoringHostServices.
 */
export function startSqlLanguageServerSession(
  socket: ShellWebSocket,
  host: SqlAuthoringHostServices,
): void {
  const webSocket: IWebSocket = {
    send: (content) => socket.send(content),
    onMessage: (listener) => socket.on("message", (data) => listener(data.toString())),
    onError: (listener) => socket.on("error", listener),
    onClose: (listener) => socket.on("close", (code, reason) => listener(code, reason.toString())),
    dispose: () => socket.close(),
  };
  const reader = new WebSocketMessageReader(webSocket);
  const writer = new WebSocketMessageWriter(webSocket);
  const connection = createConnection(ProposedFeatures.all, reader, writer);
  const session = startSqlAuthoringServer(connection, host);
  reader.onClose(() => {
    session.dispose();
    connection.dispose();
  });
}
