import { beforeEach, describe, expect, it, vi } from "vitest";

class TestUri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = "",
  ) {}

  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ""}`;
  }
}

const vscodeState = vi.hoisted(() => ({
  close: vi.fn(),
  groups: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
  tabListeners: new Set<() => void>(),
  documentCloseListeners: new Set<(document: { uri: TestUri }) => void>(),
}));

vi.mock("vscode", () => ({
  TabInputText: class {
    constructor(readonly uri: TestUri) {}
  },
  Uri: {
    from(parts: { scheme: string; path: string; query?: string }) {
      return new TestUri(parts.scheme, parts.path, parts.query);
    },
    parse(value: string) {
      const match = /^([^:]+):([^?]*)(?:\?(.*))?$/u.exec(value);
      if (!match) throw new Error("invalid URI");
      return new TestUri(match[1], match[2], match[3]);
    },
  },
  window: {
    tabGroups: {
      get all() {
        return vscodeState.groups;
      },
      close: vscodeState.close,
      onDidChangeTabs(listener: () => void) {
        vscodeState.tabListeners.add(listener);
        return { dispose: () => vscodeState.tabListeners.delete(listener) };
      },
    },
  },
  workspace: {
    onDidCloseTextDocument(listener: (document: { uri: TestUri }) => void) {
      vscodeState.documentCloseListeners.add(listener);
      return { dispose: () => vscodeState.documentCloseListeners.delete(listener) };
    },
  },
}));

import {
  completeWorkbenchDrop,
  parseWorkbenchDropUri,
  type WorkbenchDragHandoff,
  type WorkbenchDragTransportTargets,
  workbenchDragUri,
} from "./dragTransport.js";

describe("Workbench drag transport", () => {
  beforeEach(() => {
    vscodeState.groups = [];
    vscodeState.close.mockReset().mockResolvedValue(true);
    vscodeState.tabListeners.clear();
    vscodeState.documentCloseListeners.clear();
    nextHandoffId = 1;
  });

  it("round-trips one immutable payload with every visible editor-group destination", async () => {
    const vscode = await import("vscode");
    const dataViewUri = vscode.Uri.parse("postgresql-workbench-data:/connection/database/table");
    const sqlUri = vscode.Uri.parse("vscode-notebook-cell:/scratchpad/cell.sql");
    const parsed = parseWorkbenchDropUri(
      vscode.Uri.parse(
        workbenchDragUri(
          handoff([
            { viewColumn: 1, destination: { kind: "cockpit" } },
            { viewColumn: 2, destination: { kind: "data-view", uri: dataViewUri } },
            { viewColumn: 3, destination: { kind: "sql", uri: sqlUri, offset: 17 } },
          ]),
        ),
      ),
    );

    expect(parsed?.graphPayload).toEqual(graphPayload);
    expect(parsed?.id).toBe("handoff-1");
    expect(parsed?.authoringPayload).toEqual(authoringPayload);
    expect(
      parsed?.destinations.map(({ viewColumn, destination }) => ({
        viewColumn,
        kind: destination.kind,
        uri: "uri" in destination ? destination.uri.toString() : undefined,
        offset: "offset" in destination ? destination.offset : undefined,
      })),
    ).toEqual([
      { viewColumn: 1, kind: "cockpit", uri: undefined, offset: undefined },
      { viewColumn: 2, kind: "data-view", uri: dataViewUri.toString(), offset: undefined },
      { viewColumn: 3, kind: "sql", uri: sqlUri.toString(), offset: 17 },
    ]);
  });

  it("routes to the editor group where VS Code opened the dropped URI", async () => {
    const vscode = await import("vscode");
    const documentUri = vscode.Uri.parse("postgresql-workbench-drag:/handoff/test");
    const tab = { input: new vscode.TabInputText(documentUri) };
    vscodeState.groups = [
      { viewColumn: 1, tabs: [] },
      { viewColumn: 2, tabs: [tab] },
    ];
    const firstSql = vscode.Uri.parse("file:/first.sql");
    const secondSql = vscode.Uri.parse("file:/second.sql");
    const targets = transportTargets();

    await completeWorkbenchDrop(
      documentUri,
      handoff([
        { viewColumn: 1, destination: { kind: "sql", uri: firstSql, offset: 5 } },
        { viewColumn: 2, destination: { kind: "sql", uri: secondSql, offset: 23 } },
      ]),
      targets,
    );

    expect(vscodeState.close).toHaveBeenCalledWith(tab);
    expect(targets.acceptSqlDrop).toHaveBeenCalledWith(secondSql, 23, authoringPayload);
    expect(targets.acceptDataViewDrop).not.toHaveBeenCalled();
    expect(targets.acceptCockpitDrop).not.toHaveBeenCalled();
  });

  it("keeps two interleaved URI handoffs correlated with their own payloads", async () => {
    const vscode = await import("vscode");
    const target = vscode.Uri.parse("file:/target.sql");
    const secondPayload = { ...authoringPayload, oid: 77, name: "brand" };
    const firstUri = vscode.Uri.parse(
      workbenchDragUri(
        handoff([{ viewColumn: 1, destination: { kind: "sql", uri: target, offset: 1 } }]),
      ),
    );
    const secondUri = vscode.Uri.parse(
      workbenchDragUri({
        ...handoff([{ viewColumn: 1, destination: { kind: "sql", uri: target, offset: 2 } }]),
        authoringPayload: secondPayload,
      }),
    );
    const firstTab = { input: new vscode.TabInputText(firstUri) };
    const secondTab = { input: new vscode.TabInputText(secondUri) };
    const targets = transportTargets();

    vscodeState.groups = [{ viewColumn: 1, tabs: [secondTab] }];
    await completeWorkbenchDrop(secondUri, parseWorkbenchDropUri(secondUri)!, targets);
    vscodeState.groups = [{ viewColumn: 1, tabs: [firstTab] }];
    await completeWorkbenchDrop(firstUri, parseWorkbenchDropUri(firstUri)!, targets);

    expect(targets.acceptSqlDrop).toHaveBeenNthCalledWith(1, target, 2, secondPayload);
    expect(targets.acceptSqlDrop).toHaveBeenNthCalledWith(2, target, 1, authoringPayload);
    expect(targets.completeHandoff).toHaveBeenNthCalledWith(1, "handoff-2");
    expect(targets.completeHandoff).toHaveBeenNthCalledWith(2, "handoff-1");
  });

  it("waits for the editor tab event instead of abandoning a delayed drop", async () => {
    const vscode = await import("vscode");
    const destination = vscode.Uri.parse("file:/target.sql");
    const drag = handoff([
      { viewColumn: 2, destination: { kind: "sql", uri: destination, offset: 9 } },
    ]);
    const documentUri = vscode.Uri.parse(workbenchDragUri(drag));
    const tab = { input: new vscode.TabInputText(documentUri) };
    const targets = transportTargets();

    const completion = completeWorkbenchDrop(documentUri, drag, targets);
    await Promise.resolve();
    expect(vscodeState.tabListeners.size).toBe(1);
    vscodeState.groups = [{ viewColumn: 2, tabs: [tab] }];
    for (const listener of vscodeState.tabListeners) listener();
    await completion;

    expect(targets.acceptSqlDrop).toHaveBeenCalledWith(destination, 9, authoringPayload);
    expect(vscodeState.close).toHaveBeenCalledWith(tab);
    expect(vscodeState.tabListeners.size).toBe(0);
    expect(vscodeState.documentCloseListeners.size).toBe(0);
  });

  it("closes the URI overlay before handing the embedded graph payload to the Cockpit", async () => {
    const vscode = await import("vscode");
    const documentUri = vscode.Uri.parse("postgresql-workbench-drag:/handoff/graph");
    const tab = { input: new vscode.TabInputText(documentUri) };
    vscodeState.groups = [{ viewColumn: 1, tabs: [tab] }];
    const targets = transportTargets();

    await completeWorkbenchDrop(
      documentUri,
      handoff([{ viewColumn: 1, destination: { kind: "cockpit" } }]),
      targets,
    );

    expect(targets.acceptCockpitDrop).toHaveBeenCalledWith(graphPayload);
    expect(targets.revealCockpit).toHaveBeenCalledOnce();
    expect(vscodeState.close.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(targets.acceptCockpitDrop).mock.invocationCallOrder[0],
    );
  });
});

const graphPayload = {
  version: 1 as const,
  availability: "accepted" as const,
  connectionId: "connection",
  database: "demo",
  sourceUri: "postgresql://connection/demo/shop/table/orders.sql",
  symbolUri: "code+moniker://orders",
  kind: "table" as const,
  label: "shop.orders",
};

const authoringPayload = {
  kind: "table" as const,
  connectionId: "connection",
  database: "demo",
  oid: 42,
  schema: "shop",
  name: "orders",
};

let nextHandoffId = 1;

function handoff(destinations: WorkbenchDragHandoff["destinations"]): WorkbenchDragHandoff {
  return { id: `handoff-${nextHandoffId++}`, graphPayload, authoringPayload, destinations };
}

function transportTargets(): WorkbenchDragTransportTargets {
  return {
    acceptCockpitDrop: vi.fn().mockResolvedValue(true),
    acceptDataViewDrop: vi.fn().mockResolvedValue(true),
    acceptSqlDrop: vi.fn().mockResolvedValue(true),
    completeHandoff: vi.fn(),
    revealCockpit: vi.fn(),
    log: vi.fn(),
  };
}
