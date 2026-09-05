import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WorkbenchRuntime } from "../../runtime/src/index.js";
import type { ConnectionProfile } from "../../runtime/src/sessions.js";
import { createWorkbenchMcp } from "./server.js";

/** Loopback transport; every MCP client owns its database sessions and retained observations. */
export async function startWorkbenchHttp(options: {
  port: number;
  token: string;
  profiles: readonly ConnectionProfile[];
  syntaxRuntimePath?: string;
  idleTimeoutMs?: number;
  redact?: (message: string) => string;
}) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("Invalid MCP port.");
  if (options.token.length < 32)
    throw new Error("An MCP token of at least 32 characters is required.");
  const clients = new Set<{
    transport: StreamableHTTPServerTransport;
    close(): Promise<void>;
    beginRequest(): () => void;
  }>();
  let closing = false;
  const http = createServer((request, response) => {
    void (async () => {
      const expected = Buffer.from(`Bearer ${options.token}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) {
        response.writeHead(403).end();
        return;
      }
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401).end();
        return;
      }
      if (closing || request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      let client = [...clients].find(
        (entry) => entry.transport.sessionId === sessionId && sessionId,
      );
      if (!client) {
        if (sessionId || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        if (clients.size >= 16) {
          response.writeHead(503).end();
          return;
        }
        const runtime = new WorkbenchRuntime(options.profiles, options.syntaxRuntimePath);
        const server = createWorkbenchMcp(runtime, options.redact);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
        });
        let disposed: Promise<void> | undefined;
        let activeRequests = 0;
        let idleTimer: NodeJS.Timeout | undefined;
        const entry = {
          transport,
          beginRequest() {
            activeRequests++;
            clearTimeout(idleTimer);
            return () => {
              activeRequests--;
              if (!disposed && activeRequests === 0) {
                idleTimer = setTimeout(
                  () => {
                    void entry.close().catch(() => undefined);
                  },
                  options.idleTimeoutMs ?? 30 * 60_000,
                );
                idleTimer.unref();
              }
            };
          },
          close() {
            disposed ??= Promise.resolve().then(async () => {
              clearTimeout(idleTimer);
              clients.delete(entry);
              try {
                await server.close();
              } finally {
                await runtime.dispose();
              }
            });
            return disposed;
          },
        };
        clients.add(entry);
        server.server.onclose = () => {
          void entry.close();
        };
        await server.connect(transport);
        client = entry;
      }
      // A listening SSE stream is not activity; requests executing a tool keep their runtime alive.
      const finish = request.method === "GET" ? () => {} : client.beginRequest();
      try {
        await client.transport.handleRequest(request, response);
      } finally {
        finish();
        if (!client.transport.sessionId) await client.close();
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  let port = options.port;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => {
      http.off("error", reject);
      const address = http.address();
      if (address && typeof address !== "string") port = address.port;
      resolve();
    });
  });
  return {
    port,
    async close() {
      closing = true;
      const stopped = new Promise<void>((resolve) => http.close(() => resolve()));
      await Promise.allSettled([...clients].map((client) => client.close()));
      http.closeAllConnections();
      await stopped;
    },
  };
}
