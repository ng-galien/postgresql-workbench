import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeOptions = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const launch = vi.hoisted(() => vi.fn());
const stopOwned = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());

vi.mock("./codeMonikerRuntime.js", () => ({
  inspectCodeMonikerRuntime: () => ({
    rootPath: "/runtime",
    clientEntry: "/runtime/client.cjs",
    nodeEntry: "/runtime/node.cjs",
    binaryPath: "/runtime/code-moniker",
    manifest: {
      clientVersion: "0.6.0",
      protocolVersion: 7,
      source: "test",
    },
  }),
}));

vi.mock("node:module", () => ({
  createRequire: () => (entry: string) => {
    if (entry === "/runtime/client.cjs") return { PROTOCOL_VERSION: 7 };
    return {
      NodeDaemonRuntime: class {
        constructor(options?: { timeoutMs?: number }) {
          runtimeOptions(options);
        }

        findDaemon() {
          return undefined;
        }

        daemonProcessAlive() {
          return true;
        }

        forgetDaemon() {}

        connect = connect;
        launch = launch;
        stopOwned = stopOwned;
      },
    };
  },
}));

import { connectLocalCodeMoniker, ensureLocalCodeMonikerWorkspace } from "./localCodeMoniker.js";

beforeEach(() => {
  runtimeOptions.mockReset();
  connect.mockReset().mockResolvedValue({
    close,
    onDidClose: () => () => undefined,
  });
  launch.mockReset();
  stopOwned.mockReset().mockResolvedValue(undefined);
  close.mockReset();
});

describe("local Code Moniker transport", () => {
  it("applies the configured timeout to the runtime and daemon connection", async () => {
    const daemon = {
      endpoint: "ws://127.0.0.1:1234",
      pid: 42,
      token: "token",
      workspaceRoots: ["/workspace"],
    };

    const session = await connectLocalCodeMoniker({
      runtimePath: "/runtime",
      workspaceRoots: ["/workspace"],
      daemon,
      timeoutMs: 30_000,
    });

    expect(runtimeOptions).toHaveBeenCalledWith({ timeoutMs: 30_000 });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: daemon.endpoint, pid: daemon.pid }),
      {
        clientName: "postgresql-workbench",
        expectedWorkspaceRoots: ["/workspace"],
        timeoutMs: 30_000,
      },
    );

    await session.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("connects with the canonical workspace roots registered by a launched daemon", async () => {
    const entry = {
      endpoint: "ws://127.0.0.1:1234",
      pid: 42,
      token: "token",
      workspace_roots: ["\\\\?\\D:\\workspace"],
    };
    launch.mockResolvedValue({ entry });

    const session = await ensureLocalCodeMonikerWorkspace({
      runtimePath: "/runtime",
      workspaceRoots: ["d:\\workspace"],
      timeoutMs: 30_000,
    });

    expect(connect).toHaveBeenCalledWith(entry, {
      clientName: "postgresql-workbench",
      expectedWorkspaceRoots: entry.workspace_roots,
      timeoutMs: 30_000,
    });

    await session.dispose();
    expect(stopOwned).toHaveBeenCalledOnce();
  });
});
