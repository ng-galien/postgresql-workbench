import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  close: vi.fn(),
  groups: [] as Array<{ tabs: unknown[] }>,
  onDidChangeTabs: undefined as (() => void) | undefined,
}));

const deploymentState = vi.hoisted(() => ({
  client: {
    end: vi.fn(),
    query: vi.fn(),
  },
  openClient: vi.fn(),
}));

vi.mock("./coverageConnection.js", () => ({
  openCoverageClient: deploymentState.openClient,
}));

vi.mock("./managedRoutineDeployment.js", () => ({
  validateManagedRoutineDeployment: vi.fn(async () => ({ status: "valid" })),
}));

vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly callback = () => {}) {}
    dispose() {
      this.callback();
    }
  },
  EventEmitter: class {
    readonly event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  TabInputText: class {
    constructor(readonly uri: { scheme: string; toString(): string }) {}
  },
  window: {
    tabGroups: {
      get all() {
        return vscodeState.groups;
      },
      close: vscodeState.close,
      onDidChangeTabs(listener: () => void) {
        vscodeState.onDidChangeTabs = listener;
        return { dispose() {} };
      },
    },
  },
  FileSystemError: {
    FileNotFound: (message: unknown) => new Error(String(message)),
    NoPermissions: (message: unknown) => new Error(String(message)),
  },
  FileChangeType: { Changed: 1 },
}));

import {
  CodeMonikerContentProvider,
  closeUnavailableCodeMonikerTabs,
} from "./codeMonikerContentProvider.js";

describe("stale Code Moniker source tabs", () => {
  beforeEach(() => {
    vscodeState.close.mockReset().mockResolvedValue(true);
    vscodeState.groups = [];
    vscodeState.onDidChangeTabs = undefined;
    deploymentState.client.end.mockReset().mockResolvedValue(undefined);
    deploymentState.client.query.mockReset().mockResolvedValue({ rows: [] });
    deploymentState.openClient.mockReset().mockResolvedValue(deploymentState.client);
  });

  it("closes clean virtual sources that the new session cannot resolve", async () => {
    const stale = await tab("code+moniker", "code+moniker://stale", false);
    const available = await tab("code+moniker", "code+moniker://available", false);
    const regular = await tab("file", "file:///workspace/query.sql", false);
    vscodeState.groups = [{ tabs: [stale, available, regular] }];

    await closeUnavailableCodeMonikerTabs((uri) => uri.toString() === "code+moniker://available");

    expect(vscodeState.close).toHaveBeenCalledWith([stale], true);
  });

  it("preserves dirty virtual sources even when the index is unavailable", async () => {
    const dirty = await tab("code+moniker", "code+moniker://edited", true);
    vscodeState.groups = [{ tabs: [dirty] }];

    await closeUnavailableCodeMonikerTabs(() => false);

    expect(vscodeState.close).not.toHaveBeenCalled();
  });

  it("runs another cleanup pass when tabs change during an active reconciliation", async () => {
    let releaseFirstClose = () => {};
    vscodeState.close.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirstClose = () => resolve(true);
        }),
    );
    const first = await tab("code+moniker", "code+moniker://first", false);
    const second = await tab("code+moniker", "code+moniker://second", false);
    vscodeState.groups = [{ tabs: [first] }];
    const provider = new CodeMonikerContentProvider(
      {
        onServerChanged: () => ({ dispose() {} }),
      } as never,
      {
        onDidChangeState: () => ({ dispose() {} }),
        sourceDescriptorForDocumentUri: () => undefined,
      } as never,
    );
    await vi.waitFor(() => expect(vscodeState.close).toHaveBeenCalledTimes(1));

    vscodeState.groups = [{ tabs: [second] }];
    vscodeState.onDidChangeTabs?.();
    releaseFirstClose();

    await vi.waitFor(() => expect(vscodeState.close).toHaveBeenCalledTimes(2));
    expect(vscodeState.close).toHaveBeenLastCalledWith([second], true);
    provider.dispose();
  });

  it("rejects a working copy when the deployed source changed externally", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor = routineDescriptor("SELECT 1");
    const provider = providerFor(() => descriptor);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));
    descriptor = routineDescriptor("SELECT 3");

    await expect(provider.deploy(sourceUri as never)).rejects.toThrow(/changed after/u);
    expect(deploymentState.openClient).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("does not invent a deployment base for a working copy created while the index was absent", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor: ReturnType<typeof routineDescriptor> | undefined;
    const provider = providerFor(() => descriptor);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));
    descriptor = routineDescriptor("SELECT 3");
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 4"));

    await expect(provider.deploy(sourceUri as never)).rejects.toThrow(/changed after/u);
    expect(deploymentState.openClient).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("keeps the applied working copy and marks the index stale when refresh fails", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    const descriptor = routineDescriptor("SELECT 1");
    const markDatabaseStale = vi.fn();
    const provider = providerFor(() => descriptor, {
      indexPostgresDatabase: vi.fn(async () => {
        throw new Error("refresh failed");
      }),
      markDatabaseStale,
    });
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));

    await expect(provider.deploy(sourceUri as never)).resolves.toMatchObject({
      status: "deployed-with-warning",
    });
    expect(deploymentState.client.query).toHaveBeenCalledWith("SELECT 2");
    expect(markDatabaseStale).toHaveBeenCalledWith(
      "demo",
      "demo",
      "Managed routine deployed; index refresh failed",
    );
    expect(new TextDecoder().decode(await provider.readFile(sourceUri as never))).toBe("SELECT 2");
    provider.dispose();
  });
});

function providerFor(
  descriptor: () => ReturnType<typeof routineDescriptor> | undefined,
  indexOverrides: Record<string, unknown> = {},
) {
  return new CodeMonikerContentProvider(
    {
      onServerChanged: () => ({ dispose() {} }),
    } as never,
    {
      onDidChangeState: () => ({ dispose() {} }),
      sourceDescriptorForDocumentUri: descriptor,
      sqlAuthoringSnapshot: () => ({ status: "available" }),
      syntaxParser: vi.fn(),
      ...indexOverrides,
    } as never,
  );
}

function routineDescriptor(content: string) {
  return {
    symbolUri: "code+moniker://routine",
    sourceUri: "postgresql://demo/routine.sql",
    serverId: "demo",
    database: "demo",
    schema: "public",
    documentKind: "routine" as const,
    oid: 1,
    name: "routine",
    signature: "",
    symbolKind: "function",
    plpgsql: true,
    revision: "one",
    generation: 1,
    content,
  };
}

function uri(scheme: string, value: string) {
  const result = {
    scheme,
    query: "",
    fragment: "",
    toString: () => value,
    with: () => result,
  };
  return result;
}

async function tab(scheme: string, value: string, isDirty: boolean) {
  const { TabInputText } = await import("vscode");
  return {
    isDirty,
    input: new TabInputText(uri(scheme, value) as never),
  };
}
