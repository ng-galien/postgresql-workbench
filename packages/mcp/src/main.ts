import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkbenchRuntime } from "../../runtime/src/index.js";
import { environmentProfiles, secretRedactor } from "./configuration.js";
import { createWorkbenchMcp } from "./server.js";

async function main() {
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
