import * as vscode from "vscode";
import {
  parseSqlAuthoringDrag,
  type SqlAuthoringDragPayload,
} from "../../../packages/sql/src/snapshot.js";
import {
  parseWorkbenchGraphDrag,
  type WorkbenchGraphDragPayload,
} from "../../../packages/views/src/cockpit/dragAndDrop.js";

const WORKBENCH_DRAG_SCHEME = "postgresql-workbench-drag";
const WORKBENCH_DRAG_VERSION = 1;

export interface WorkbenchDragTransportTargets {
  acceptCockpitDrop(payload: WorkbenchGraphDragPayload): Promise<boolean>;
  acceptDataViewDrop(uri: vscode.Uri, payload: SqlAuthoringDragPayload): Promise<boolean>;
  acceptSqlDrop(
    uri: vscode.Uri,
    offset: number,
    payload: SqlAuthoringDragPayload,
  ): Promise<boolean>;
  completeHandoff(handoffId: string): void;
  revealCockpit(): void;
  log?(message: string): void;
}

export type WorkbenchDropDestination =
  | { kind: "cockpit" }
  | { kind: "data-view"; uri: vscode.Uri }
  | { kind: "sql"; uri: vscode.Uri; offset: number };

export interface WorkbenchDragHandoff {
  id: string;
  graphPayload: WorkbenchGraphDragPayload;
  authoringPayload?: SqlAuthoringDragPayload;
  destinations: readonly {
    viewColumn: vscode.ViewColumn;
    destination: WorkbenchDropDestination;
  }[];
}

interface SerializedHandoff {
  version: typeof WORKBENCH_DRAG_VERSION;
  id: string;
  graphPayload: WorkbenchGraphDragPayload;
  authoringPayload?: SqlAuthoringDragPayload;
  destinations: readonly {
    viewColumn: number;
    destination:
      | { kind: "cockpit" }
      | { kind: "data-view"; uri: string }
      | { kind: "sql"; uri: string; offset: number };
  }[];
}

/**
 * VS Code only lets a native TreeView drag cross its editor overlay when it carries a URI flavor.
 * The URI is an immutable handoff: it correlates the exact payload with every visible destination,
 * while the editor group under the pointer chooses which destination receives it.
 */
export function workbenchDragUri(handoff: WorkbenchDragHandoff): string {
  const serialized: SerializedHandoff = {
    version: WORKBENCH_DRAG_VERSION,
    id: handoff.id,
    graphPayload: handoff.graphPayload,
    ...(handoff.authoringPayload ? { authoringPayload: handoff.authoringPayload } : {}),
    destinations: handoff.destinations.map(({ viewColumn, destination }) => ({
      viewColumn,
      destination:
        destination.kind === "cockpit"
          ? destination
          : { ...destination, uri: destination.uri.toString() },
    })),
  };
  return vscode.Uri.from({
    scheme: WORKBENCH_DRAG_SCHEME,
    path: `/handoff/${handoff.id}`,
    query: `value=${Buffer.from(JSON.stringify(serialized), "utf8").toString("base64url")}`,
  }).toString();
}

/** Routes the immutable handoff through the editor group where VS Code opens the dropped URI. */
export function registerWorkbenchDragTransport(
  context: vscode.ExtensionContext,
  targets: WorkbenchDragTransportTargets,
): void {
  const lifecycle = new vscode.CancellationTokenSource();
  const provider = vscode.workspace.registerTextDocumentContentProvider(WORKBENCH_DRAG_SCHEME, {
    provideTextDocumentContent: () =>
      "Drop this PostgreSQL object into a SQL editor, Data View, or Cockpit.\n",
  });
  const opened = vscode.workspace.onDidOpenTextDocument((document) => {
    if (document.uri.scheme !== WORKBENCH_DRAG_SCHEME) return;
    const handoff = parseWorkbenchDropUri(document.uri);
    if (!handoff) {
      targets.log?.("Workbench drag transport handoff was not recognized.");
      return;
    }
    void completeWorkbenchDrop(document.uri, handoff, targets, lifecycle.token);
  });
  context.subscriptions.push(provider, opened, lifecycle);
}

export async function completeWorkbenchDrop(
  documentUri: vscode.Uri,
  handoff: WorkbenchDragHandoff,
  targets: WorkbenchDragTransportTargets,
  cancellation?: vscode.CancellationToken,
): Promise<void> {
  const opened = await waitForSyntheticTab(documentUri, cancellation);
  if (!opened) {
    targets.log?.("Workbench drag transport could not identify the editor group under the drop.");
    return;
  }
  const route = handoff.destinations.find(
    ({ viewColumn }) => viewColumn === opened.group.viewColumn,
  )?.destination;
  targets.completeHandoff(handoff.id);
  await vscode.window.tabGroups.close(opened.tab);
  try {
    if (!route) {
      targets.log?.(
        `Workbench drag transport found no destination in editor group ${opened.group.viewColumn}.`,
      );
      return;
    }
    targets.log?.(`Workbench drag transport routing ${route.kind}.`);
    if (route.kind === "cockpit") {
      if (await targets.acceptCockpitDrop(handoff.graphPayload)) targets.revealCockpit();
      return;
    }
    const payload = handoff.authoringPayload;
    if (!payload) return;
    if (route.kind === "data-view") {
      await targets.acceptDataViewDrop(route.uri, payload);
      return;
    }
    await targets.acceptSqlDrop(route.uri, route.offset, payload);
  } finally {
    await closeSyntheticTab(documentUri);
  }
}

export function parseWorkbenchDropUri(uri: vscode.Uri): WorkbenchDragHandoff | undefined {
  if (uri.scheme !== WORKBENCH_DRAG_SCHEME || !uri.path.startsWith("/handoff/")) return undefined;
  const encoded = new URLSearchParams(uri.query).get("value");
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const pathId = uri.path.slice("/handoff/".length);
    if (
      parsed.version !== WORKBENCH_DRAG_VERSION ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      parsed.id !== pathId ||
      !Array.isArray(parsed.destinations)
    ) {
      return undefined;
    }
    const graphPayload = parseWorkbenchGraphDrag(JSON.stringify(parsed.graphPayload));
    if (!graphPayload) return undefined;
    const authoringPayload = parsed.authoringPayload
      ? parseSqlAuthoringDrag(JSON.stringify(parsed.authoringPayload))
      : undefined;
    if (parsed.authoringPayload && !authoringPayload) return undefined;
    const destinations = parsed.destinations.map(parseDestination);
    if (destinations.some((destination) => destination === undefined)) return undefined;
    return {
      id: parsed.id,
      graphPayload,
      ...(authoringPayload ? { authoringPayload } : {}),
      destinations: destinations as WorkbenchDragHandoff["destinations"],
    };
  } catch {
    return undefined;
  }
}

function parseDestination(
  value: unknown,
): WorkbenchDragHandoff["destinations"][number] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    viewColumn?: unknown;
    destination?: { kind?: unknown; uri?: unknown; offset?: unknown };
  };
  if (!Number.isSafeInteger(candidate.viewColumn) || Number(candidate.viewColumn) < 1) {
    return undefined;
  }
  const viewColumn = candidate.viewColumn as vscode.ViewColumn;
  const destination = candidate.destination;
  if (!destination || typeof destination !== "object") return undefined;
  if (destination.kind === "cockpit") return { viewColumn, destination: { kind: "cockpit" } };
  if (typeof destination.uri !== "string") return undefined;
  const uri = vscode.Uri.parse(destination.uri);
  if (destination.kind === "data-view") {
    return { viewColumn, destination: { kind: "data-view", uri } };
  }
  if (
    destination.kind !== "sql" ||
    !Number.isSafeInteger(destination.offset) ||
    Number(destination.offset) < 0
  ) {
    return undefined;
  }
  return {
    viewColumn,
    destination: { kind: "sql", uri, offset: Number(destination.offset) },
  };
}

async function waitForSyntheticTab(
  documentUri: vscode.Uri,
  cancellation?: vscode.CancellationToken,
): Promise<{ tab: vscode.Tab; group: vscode.TabGroup } | undefined> {
  const current = syntheticTab(documentUri);
  if (current) return current;
  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (value: { tab: vscode.Tab; group: vscode.TabGroup } | undefined) => {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions) subscription.dispose();
      resolve(value);
    };
    subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const opened = syntheticTab(documentUri);
        if (opened) finish(opened);
      }),
    );
    subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === documentUri.toString()) finish(undefined);
      }),
    );
    if (cancellation) {
      subscriptions.push(cancellation.onCancellationRequested(() => finish(undefined)));
    }
    const opened = syntheticTab(documentUri);
    if (opened) finish(opened);
    else if (cancellation?.isCancellationRequested) finish(undefined);
  });
}

async function closeSyntheticTab(documentUri: vscode.Uri): Promise<void> {
  const opened = syntheticTab(documentUri);
  if (opened) await vscode.window.tabGroups.close(opened.tab);
}

function syntheticTab(
  documentUri: vscode.Uri,
): { tab: vscode.Tab; group: vscode.TabGroup } | undefined {
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.tabs.find((candidate) => {
      const input = candidate.input;
      const uri = input && typeof input === "object" ? resourceUriOf(input) : undefined;
      return uri?.toString() === documentUri.toString();
    });
    if (tab) return { tab, group };
  }
  return undefined;
}

function resourceUriOf(input: object): vscode.Uri | undefined {
  if (!("uri" in input)) return undefined;
  const uri = input.uri;
  return uri && typeof uri === "object" && "toString" in uri && typeof uri.toString === "function"
    ? (uri as vscode.Uri)
    : undefined;
}
