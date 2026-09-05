import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Locator, TestInfo } from "@playwright/test";
import { demoConnectionId } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import type { VSCodeInstance } from "../../fixtures/vscode";
import type { ConnectionsPage } from "../../pages/ConnectionsPage";

test("manages MCP and installs project clients from Settings", async ({
  connectionsPage,
  vscode,
}, testInfo) => {
  for (const cycle of [1, 2]) {
    await test.step(`complete and clean up MCP cycle ${cycle} in the same VS Code host`, () =>
      exerciseMcpCycle(connectionsPage, vscode, testInfo));
  }
});

async function applyPort(settings: Locator, port: string): Promise<void> {
  const url = settings.locator(":scope > p > code");
  const expectedUrl = `http://127.0.0.1:${port}/mcp`;
  if ((await url.textContent()) !== expectedUrl) {
    await settings.getByLabel("MCP port", { exact: true }).fill(port);
    await settings.getByRole("button", { name: "Apply port", exact: true }).click();
  }
  await expect(url).toHaveText(expectedUrl);
  await expect(settings.getByRole("button", { name: "Refresh MCP status" })).toBeEnabled();
}

async function exerciseMcpCycle(
  connectionsPage: ConnectionsPage,
  vscode: VSCodeInstance,
  testInfo: TestInfo,
): Promise<void> {
  const frame = await connectionsPage.open();
  await frame
    .locator(".connections-sidebar-tool-actions")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await frame.getByRole("button", { name: "MCP", exact: true }).click();
  const settings = frame.getByRole("region", { name: "MCP server", exact: true });
  const codex = settings.getByRole("region", { name: "Codex integration" });
  const claude = settings.getByRole("region", { name: "Claude Code integration" });
  await expect(settings.getByRole("status")).toHaveText("Stopped");
  const originalPort = await settings.getByLabel("MCP port", { exact: true }).inputValue();
  const files = [
    join(vscode.workspacePath, ".codex/config.toml"),
    join(vscode.workspacePath, ".mcp.json"),
  ];
  const snapshots = await Promise.all(
    [...files, join(vscode.workspacePath, ".git/info/exclude")].map(async (path) => ({
      path,
      content: await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      }),
    })),
  );
  let client: Client | undefined;
  const errors: string[] = [];
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  try {
    await applyPort(settings, String(port));
    await settings.getByLabel("Connection available to agents").selectOption(demoConnectionId);
    await settings.getByRole("button", { name: "Start MCP server" }).click();
    await expect(settings.getByRole("alert")).toHaveText(
      "The MCP port is already in use. Choose another port.",
    );
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await settings.getByRole("button", { name: "Start MCP server" }).click();
    await expect(settings.getByRole("status")).toHaveText(/Running · PID \d+/u);
    for (const integration of [codex, claude]) {
      await expect(integration).toContainText("Not installed");
      await integration.getByRole("button").click();
      await expect(integration).toContainText("Installed · client approval not checked");
    }
    const configuration = JSON.parse(await readFile(files[1]!, "utf8")).mcpServers[
      "postgresql-workbench"
    ];
    client = new Client({ name: "settings-acceptance", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(configuration.url), {
      requestInit: { headers: configuration.headers },
    });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(16);
    const result = await client.callTool({
      name: "session_open",
      arguments: { profileId: demoConnectionId },
    });
    expect(result.isError).not.toBe(true);
    await settings.getByRole("button", { name: "Stop MCP server" }).click();
    await expect(settings.getByRole("status")).toHaveText("Stopped");
    await expect(fetch(configuration.url)).rejects.toThrow();
    await applyPort(settings, String(port === 65535 ? port - 1 : port + 1));
    await expect(codex).toContainText("Different configuration");
    await codex.getByRole("button").click();
    await expect(codex).toContainText("Installed · client approval not checked");
  } finally {
    const cleanup = async (name: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch {
        errors.push(name);
      }
    };
    await Promise.all([
      cleanup("close occupied port", async () => {
        if (occupied.listening) {
          await new Promise<void>((resolve) => occupied.close(() => resolve()));
        }
      }),
      cleanup("close MCP client", async () => client?.close()),
    ]);
    await cleanup("stop MCP server", async () => {
      await expect(settings.getByRole("button", { name: "Refresh MCP status" })).toBeEnabled();
      if (await settings.getByRole("button", { name: "Stop MCP server" }).isEnabled()) {
        await settings.getByRole("button", { name: "Stop MCP server" }).click();
      }
      await expect(settings.getByRole("status")).toHaveText("Stopped");
    });
    await cleanup("restore MCP port", () => applyPort(settings, originalPort));
    for (const snapshot of snapshots) {
      await cleanup(`restore ${snapshot.path}`, () =>
        snapshot.content === undefined
          ? rm(snapshot.path, { force: true })
          : writeFile(snapshot.path, snapshot.content),
      );
    }
    await cleanup("refresh restored project configurations", async () => {
      await settings.getByRole("button", { name: "Refresh MCP status" }).click();
      for (const integration of [codex, claude]) {
        await expect(integration).toContainText("Not installed");
      }
      await settings.getByLabel("Connection available to agents").selectOption("");
    });
    if (errors.length > 0) {
      await testInfo
        .attach("mcp-cleanup-failures", {
          body: errors.join("\n"),
          contentType: "text/plain",
        })
        .catch(() => {});
    }
  }
  if (errors.length > 0) throw new Error(`MCP cleanup failed: ${errors.join(", ")}`);
}
