import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { demoConnectionId } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test("manages MCP and installs project clients from Settings", async ({ connectionsPage }) => {
  const frame = await connectionsPage.open();
  await frame
    .locator(".connections-sidebar-tool-actions")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await frame.getByRole("button", { name: "MCP", exact: true }).click();
  const settings = frame.getByRole("region", { name: "MCP server", exact: true });
  const codex = settings.getByRole("region", { name: "Codex integration" });
  const claude = settings.getByRole("region", { name: "Claude Code integration" });
  const files: string[] = [];
  let client: Client | undefined;
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  try {
    await expect(settings.getByRole("status")).toHaveText("Stopped");
    await settings.getByLabel("MCP port", { exact: true }).fill(String(port));
    await settings.getByRole("button", { name: "Apply port" }).click();
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
      files.push((await integration.locator("code").textContent())!);
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
    await settings
      .getByLabel("MCP port", { exact: true })
      .fill(String(port === 65535 ? port - 1 : port + 1));
    await settings.getByRole("button", { name: "Apply port" }).click();
    await expect(codex).toContainText("Different configuration");
    await codex.getByRole("button").click();
    await expect(codex).toContainText("Installed · client approval not checked");
  } finally {
    occupied.close();
    await client?.close();
    if (await settings.getByRole("button", { name: "Stop MCP server" }).isEnabled()) {
      await settings.getByRole("button", { name: "Stop MCP server" }).click();
      await expect(settings.getByRole("status")).toHaveText("Stopped");
    }
    for (const file of files) await rm(file, { force: true });
  }
});
