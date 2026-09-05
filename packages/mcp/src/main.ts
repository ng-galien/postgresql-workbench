import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkbenchRuntime } from "../../runtime/src/index.js";
import { environmentProfiles, secretRedactor } from "./configuration.js";
import { startWorkbenchHttp } from "./http.js";
import { createWorkbenchMcp } from "./server.js";

async function main() {
  if (process.env.PGWB_MCP_PORT) {
    const service = await startWorkbenchHttp({
      port: Number(process.env.PGWB_MCP_PORT),
      token: process.env.PGWB_MCP_TOKEN ?? "",
      profiles: environmentProfiles(process.env),
      redact: secretRedactor(process.env),
    });
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= service.close();
      return closing;
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.stderr.write(`Workbench MCP listening on http://127.0.0.1:${service.port}/mcp\n`);
    return;
  }
  const runtime = new WorkbenchRuntime(environmentProfiles(process.env));
  const server = createWorkbenchMcp(runtime, secretRedactor(process.env));
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= Promise.resolve().then(async () => {
      await server.close();
      await runtime.dispose();
    });
    return shutdown;
  };
  process.once("SIGINT", () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  });
  server.server.onclose = () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  });
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  process.stderr.write(
    "Workbench MCP could not start. Check its connection profile configuration.\n",
  );
  process.exitCode = 1;
});
