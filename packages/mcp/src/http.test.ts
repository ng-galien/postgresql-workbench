import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client as PgClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { startWorkbenchHttp } from "./http.js";

describe("local HTTP MCP", () => {
  it("expires abandoned sessions after a normal client close without DELETE", async () => {
    const token = "test-token-with-at-least-32-characters";
    const backend = {
      query: vi.fn().mockResolvedValue({ rows: [{ database: "test", user: "test", pid: 123 }] }),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const service = await startWorkbenchHttp({
      port: 0,
      token,
      profiles: [
        {
          id: "test",
          label: "Test",
          async open() {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return backend as unknown as PgClient;
          },
        },
      ],
      idleTimeoutMs: 100,
    });
    const url = new URL(`http://127.0.0.1:${service.port}/mcp`);
    const client = new Client({ name: "abandoned-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      // Opening the backend exceeds the idle budget; an active operation must survive it.
      expect(
        (await client.callTool({ name: "session_open", arguments: { profileId: "test" } })).isError,
      ).not.toBe(true);
      expect(backend.end).not.toHaveBeenCalled();
      const session = transport.sessionId!;
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(backend.end).toHaveBeenCalledOnce();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "mcp-session-id": session,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(response.status).toBe(404);
      await response.body?.cancel();
    } finally {
      await client.close();
      await service.close();
    }
  });
  it("authenticates, refuses browser origins and isolates client sessions", async () => {
    const token = "test-token-with-at-least-32-characters";
    const service = await startWorkbenchHttp({ port: 0, token, profiles: [] });
    const url = new URL(`http://127.0.0.1:${service.port}/mcp`);
    const clients: Client[] = [];
    try {
      expect((await fetch(url)).status).toBe(401);
      expect(
        (
          await fetch(url, {
            headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
          })
        ).status,
      ).toBe(403);
      const transports: StreamableHTTPClientTransport[] = [];
      for (let index = 0; index < 2; index++) {
        const client = new Client({ name: "http-test", version: "1" });
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        await client.connect(transport);
        clients.push(client);
        transports.push(transport);
        expect((await client.listTools()).tools).toHaveLength(16);
      }
      expect(transports[0]!.sessionId).not.toBe(transports[1]!.sessionId);
      await transports[0]!.terminateSession();
      expect(
        (await clients[1]!.callTool({ name: "workbench_context", arguments: {} })).isError,
      ).not.toBe(true);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await service.close();
    }
    await expect(fetch(url)).rejects.toThrow();
  });
});
