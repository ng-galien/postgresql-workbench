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

vi.mock("../coverage/index.js", () => ({
  openCoverageClient: deploymentState.openClient,
}));

vi.mock("../../../packages/sql/src/routines/validateDeployment.js", () => ({
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
  FileType: { File: 1, Directory: 2 },
  FilePermission: { Readonly: 1 },
}));

import { CodeMonikerContentProvider, closeUnavailableCodeMonikerTabs } from "./contentProvider.js";

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

  it("invalidates cached sources only for the changed Connexion", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor = routineDescriptor("SELECT 1");
    let onServerChanged: ((change: { serverIds: string[] }) => void) | undefined;
    const provider = new CodeMonikerContentProvider(
      {
        onServerChanged: (listener: (change: { serverIds: string[] }) => void) => {
          onServerChanged = listener;
          return { dispose() {} };
        },
      } as never,
      {
        onDidChangeState: () => ({ dispose() {} }),
        sourceDescriptorForDocumentUri: () => descriptor,
      } as never,
    );
    expect(new TextDecoder().decode(await provider.readFile(sourceUri as never))).toBe("SELECT 1");
    descriptor = routineDescriptor("SELECT 2");

    onServerChanged?.({ serverIds: ["another-server"] });
    expect(new TextDecoder().decode(await provider.readFile(sourceUri as never))).toBe("SELECT 1");

    onServerChanged?.({ serverIds: ["demo"] });
    expect(new TextDecoder().decode(await provider.readFile(sourceUri as never))).toBe("SELECT 2");
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

    await expect(provider.deploy(sourceUri as never)).rejects.toThrow(/No deployment base/u);
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

  it("captures the deployment base when the source is opened, not at the first save", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor = routineDescriptor("SELECT 1");
    const provider = providerFor(() => descriptor);
    expect(new TextDecoder().decode(await provider.readFile(sourceUri as never))).toBe("SELECT 1");
    descriptor = routineDescriptor("SELECT 3");
    provider.invalidateAll();
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));

    await expect(provider.deploy(sourceUri as never)).rejects.toThrow(/changed after/u);
    expect(deploymentState.openClient).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("deploys a working copy whose base matches the source the user opened", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor = routineDescriptor("SELECT 1");
    const provider = providerFor(() => descriptor, {
      indexPostgresDatabase: vi.fn(async () => {
        descriptor = routineDescriptor("SELECT 2");
      }),
    });
    await provider.readFile(sourceUri as never);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));

    await expect(provider.deploy(sourceUri as never)).resolves.toEqual({ status: "deployed" });
    expect(deploymentState.client.query).toHaveBeenCalledWith("SELECT 2");
    expect(provider.hasWorkingCopy(sourceUri as never)).toBe(false);
    provider.dispose();
  });

  it("rebases the working copy after a deployment whose index refresh failed", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    let descriptor = routineDescriptor("SELECT 1");
    const indexPostgresDatabase = vi
      .fn()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockImplementation(async () => {
        descriptor = routineDescriptor("SELECT 2");
      });
    const provider = providerFor(() => descriptor, {
      indexPostgresDatabase,
      markDatabaseStale: vi.fn(),
    });
    await provider.readFile(sourceUri as never);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));
    await expect(provider.deploy(sourceUri as never)).resolves.toMatchObject({
      status: "deployed-with-warning",
    });

    descriptor = routineDescriptor("SELECT 2");
    await expect(provider.deploy(sourceUri as never)).resolves.toEqual({ status: "deployed" });
    expect(deploymentState.client.query).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  it("asks to reopen a persisted working copy that has no deployment base", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    const descriptor = routineDescriptor("SELECT 1");
    const provider = providerFor(
      () => descriptor,
      {},
      {
        get: () => ({ "code+moniker://routine": "SELECT 2" }),
        update: vi.fn(async () => {}),
      },
    );

    await expect(provider.deploy(sourceUri as never)).rejects.toThrow(
      "No deployment base is recorded for this working copy. Reopen the routine before deploying.",
    );
    expect(deploymentState.openClient).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("reports whether a working copy diverges from the deployed source", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    const descriptor = routineDescriptor("SELECT 1");
    const provider = providerFor(() => descriptor);

    expect(provider.workingCopyDiffersFromDeployed(sourceUri as never)).toBe(false);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 1"));
    expect(provider.workingCopyDiffersFromDeployed(sourceUri as never)).toBe(false);
    await provider.writeFile(sourceUri as never, new TextEncoder().encode("SELECT 2"));
    expect(provider.workingCopyDiffersFromDeployed(sourceUri as never)).toBe(true);
    provider.dispose();
  });

  it("marks managed non-PL/pgSQL sources read-only in stat", async () => {
    const sourceUri = uri("code+moniker", "code+moniker://routine");
    const table = { ...routineDescriptor("CREATE TABLE t ()"), plpgsql: false };
    const provider = providerFor(() => table);

    await expect(provider.stat(sourceUri as never)).resolves.toMatchObject({ permissions: 1 });
    await expect(provider.writeFile(sourceUri as never, new Uint8Array())).rejects.toThrow(
      /read-only/u,
    );

    const routine = providerFor(() => routineDescriptor("SELECT 1"));
    expect(await routine.stat(sourceUri as never)).not.toHaveProperty("permissions");
    provider.dispose();
    routine.dispose();
  });
});

function providerFor(
  descriptor: () => ReturnType<typeof routineDescriptor> | undefined,
  indexOverrides: Record<string, unknown> = {},
  state?: { get: (key: string, defaultValue: unknown) => unknown; update: () => Promise<void> },
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
      indexPostgresDatabase: vi.fn(async () => {}),
      ...indexOverrides,
    } as never,
    undefined,
    state as never,
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
