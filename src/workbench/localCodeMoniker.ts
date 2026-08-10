import { createRequire } from "node:module";
import type { CodeMonikerSyntaxClient } from "../analysis/codeMonikerSyntax.js";
import { inspectCodeMonikerRuntime } from "./codeMonikerRuntime.js";
import type { PostgresDocumentDescriptor, VirtualSqlSourceSet } from "./postgresCatalog.js";

export interface CodeMonikerSymbol {
  id?: string;
  uri: string;
  name: string;
  kind: string;
  language?: string;
  file: string;
  root?: string;
  signature: string;
  visibility?: string;
  navigable?: boolean;
  line_range?: [number, number] | null;
  source?: {
    file: string;
    first_line: number;
    last_line: number;
    lines: Array<{ number: number; text: string }>;
  } | null;
  /** Caller-owned PostgreSQL lookup data; never part of the canonical symbol URI. */
  postgres?: PostgresDocumentDescriptor;
}

export interface CodeMonikerIdentitySegment {
  defs: number;
  has_children: boolean;
  identity: string;
  kind: string;
  name: string;
  segment: string;
  symbol?: CodeMonikerSymbol | null;
}

export interface CodeMonikerIdentityGraphEdge {
  count: number;
  kinds: string[];
  source: string;
  target: string;
}

export interface CodeMonikerIdentityGraphPort {
  count: number;
  identity: string;
  kinds: string[];
}

export interface CodeMonikerIdentityGraphResult {
  coverage: {
    edges_emitted: number;
    edges_matching: number;
    edges_total: number;
    nodes_emitted: number;
    nodes_total: number;
    ports_in_emitted: number;
    ports_in_matching: number;
    ports_in_total: number;
    ports_out_emitted: number;
    ports_out_matching: number;
    ports_out_total: number;
    rows_emitted: number;
    rows_matching: number;
    rows_total: number;
  };
  edges: CodeMonikerIdentityGraphEdge[];
  min_count: number;
  nodes: CodeMonikerIdentitySegment[];
  path: string[];
  ports_in: CodeMonikerIdentityGraphPort[];
  ports_out: CodeMonikerIdentityGraphPort[];
  prefix: string;
  unlinked: {
    external: number;
    manifest_blocked: number;
    unresolved: number;
    [key: string]: unknown;
  };
}

export interface CodeMonikerIdentityGraphPage {
  data: CodeMonikerIdentityGraphResult;
  generation: { value?: number } | number | null;
  nextCursor: unknown | null;
}

export interface CodeMonikerGraphResult {
  focus: { kind: string; symbol?: CodeMonikerSymbol };
  coverage: {
    callers: { matching: number; returned: number; total: number };
    callees: { matching: number; returned: number; total: number };
    internal_edges: { matching: number; returned: number; total: number };
    members: { matching: number; returned: number; total: number };
  };
  unlinked: CodeMonikerIdentityGraphResult["unlinked"];
  callers: Array<{
    count: number;
    kinds: string[];
    symbol: CodeMonikerSymbol;
  }>;
  callees: Array<{
    count: number;
    kinds: string[];
    symbol: CodeMonikerSymbol;
  }>;
}

export interface CodeMonikerUsage {
  direction: "incoming" | "outgoing" | "both";
  file: string;
  [key: string]: unknown;
}

export interface CodeMonikerUsagesPage {
  data: { rows: CodeMonikerUsage[]; total: number };
  generation: { value?: number } | number | null;
  nextCursor: unknown | null;
}

export interface CodeMonikerClient extends CodeMonikerSyntaxClient {
  readonly workspace: {
    status(): Promise<{
      phase: "loading" | "ready" | "refreshing" | "failed";
      failure?: { message: string } | null;
      generation?: { value?: number } | number | null;
    }>;
  };
  readonly sources: {
    replace(sourceSet: VirtualSqlSourceSet): Promise<unknown>;
    remove(srcset: string): Promise<unknown>;
  };
  readonly symbols: {
    search(
      options?: Record<string, unknown>,
      queryOptions?: Record<string, unknown>,
    ): Promise<{
      data: { rows: CodeMonikerSymbol[]; total: number };
      generation: { value?: number } | number | null;
      nextCursor: unknown | null;
    }>;
    detail(
      uri: string,
      options?: { contextLines?: number; workspace?: string | null },
      queryOptions?: Record<string, unknown>,
    ): Promise<{ symbol: CodeMonikerSymbol; source?: CodeMonikerSymbol["source"] }>;
    usages(
      uri: string,
      options?: {
        workspace?: string | null;
        direction?: "incoming" | "outgoing" | "both";
        includeDescendants?: boolean;
        path?: string[];
        language?: string[];
      },
      queryOptions?: Record<string, unknown>,
    ): Promise<CodeMonikerUsagesPage>;
  };
  readonly graph: {
    symbol(
      focus: string,
      options?: {
        workspace?: string | null;
        direction?: "incoming" | "outgoing" | "both";
        relation?: string[];
        minCount?: number;
        includeInternal?: boolean;
      },
      queryOptions?: Record<string, unknown>,
    ): Promise<CodeMonikerGraphResult>;
    children(
      prefix: string,
      options?: Record<string, unknown>,
      queryOptions?: Record<string, unknown>,
    ): Promise<{ prefix: string; children: CodeMonikerIdentitySegment[] }>;
    identity(
      prefix: string,
      options?: Record<string, unknown>,
      queryOptions?: Record<string, unknown>,
    ): Promise<CodeMonikerIdentityGraphPage>;
  };
  supportsQuery(name: string): boolean;
  supportsCommand(name: string): boolean;
  onDidClose(listener: () => void): () => void;
  close(): void;
}

interface DaemonRegistryEntry {
  endpoint: string;
  pid: number;
  token: string;
  workspace_roots: string[];
}

interface OwnedDaemon {
  entry: DaemonRegistryEntry;
}

interface NodeDaemonRuntime {
  findDaemon(workspaceRoots: readonly string[]): DaemonRegistryEntry | undefined;
  daemonProcessAlive(pid: number): boolean;
  forgetDaemon(expected: DaemonRegistryEntry): void;
  launch(options: {
    workspaceRoots: readonly string[];
    binaryCandidates: readonly string[];
  }): Promise<OwnedDaemon>;
  connect(
    entry: DaemonRegistryEntry,
    options?: { clientName?: string; timeoutMs?: number },
  ): Promise<CodeMonikerClient>;
  stopOwned(
    owned: OwnedDaemon,
    options?: { exitTimeoutMs?: number; pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<void>;
  restart(
    entry: DaemonRegistryEntry,
    launchOptions: {
      workspaceRoots: readonly string[];
      binaryCandidates: readonly string[];
    },
    stopOptions?: { exitTimeoutMs?: number; pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<OwnedDaemon>;
}

interface NodeDaemonRuntimeConstructor {
  new (options?: { timeoutMs?: number }): NodeDaemonRuntime;
}

interface LocalNodeModule {
  NodeDaemonRuntime: NodeDaemonRuntimeConstructor;
}

interface LocalClientModule {
  PROTOCOL_VERSION: number;
}

export interface LocalCodeMonikerOptions {
  runtimePath: string;
  workspaceRoots: readonly string[];
  clientName?: string;
  daemon?: LocalCodeMonikerDaemon;
  timeoutMs?: number;
}

export interface LocalCodeMonikerDaemon {
  endpoint: string;
  pid: number;
  token: string;
  workspaceRoots: string[];
}

export interface LocalCodeMonikerMetadata {
  runtimePath: string;
  source: string;
  packageVersion: string;
  protocolVersion: number;
  binaryPath?: string;
  daemonPid: number;
  ownedDaemon: boolean;
}

export class LocalCodeMonikerSession {
  private disposed = false;

  constructor(
    readonly client: CodeMonikerClient,
    readonly metadata: LocalCodeMonikerMetadata,
    readonly daemon: LocalCodeMonikerDaemon,
    private readonly runtime: NodeDaemonRuntime,
    private readonly owned: OwnedDaemon | undefined,
  ) {}

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.client.close();
    if (this.owned) {
      await this.runtime.stopOwned(this.owned, { exitTimeoutMs: 10_000 });
    }
  }
}

export async function connectLocalCodeMoniker(
  options: LocalCodeMonikerOptions,
): Promise<LocalCodeMonikerSession> {
  return openLocalCodeMoniker(options, false);
}

export async function ensureLocalCodeMonikerWorkspace(
  options: LocalCodeMonikerOptions,
): Promise<LocalCodeMonikerSession> {
  return openLocalCodeMoniker(options, true);
}

async function openLocalCodeMoniker(
  options: LocalCodeMonikerOptions,
  mayLaunch: boolean,
): Promise<LocalCodeMonikerSession> {
  if (options.workspaceRoots.length === 0) {
    throw new Error("Code Moniker requires at least one workspace root");
  }
  const packaged = inspectCodeMonikerRuntime(options.runtimePath);
  const require = createRequire(packaged.clientEntry);
  const nodeModule = require(packaged.nodeEntry) as LocalNodeModule;
  const clientModule = require(packaged.clientEntry) as LocalClientModule;
  if (typeof nodeModule.NodeDaemonRuntime !== "function") {
    throw new Error("Local Code Moniker client does not expose NodeDaemonRuntime");
  }
  if (!Number.isInteger(clientModule.PROTOCOL_VERSION)) {
    throw new Error("Packaged Code Moniker client does not expose a protocol version");
  }
  if (clientModule.PROTOCOL_VERSION !== packaged.manifest.protocolVersion) {
    throw new Error(
      `Packaged Code Moniker client protocol ${clientModule.PROTOCOL_VERSION} ` +
        `does not match runtime manifest protocol ${packaged.manifest.protocolVersion}`,
    );
  }

  const runtime = new nodeModule.NodeDaemonRuntime({ timeoutMs: options.timeoutMs });
  let configured = options.daemon
    ? daemonRegistryEntry(options.daemon)
    : runtime.findDaemon(options.workspaceRoots);
  if (configured && !runtime.daemonProcessAlive(configured.pid)) {
    runtime.forgetDaemon(configured);
    configured = undefined;
  }
  if (!configured && !mayLaunch) {
    throw new Error(
      `No Code Moniker daemon is running for workspace roots: ${options.workspaceRoots.join(", ")}`,
    );
  }
  const existing = configured;
  const launchOptions = {
    workspaceRoots: options.workspaceRoots,
    binaryCandidates: [packaged.binaryPath],
  };
  let owned = existing ? undefined : await runtime.launch(launchOptions);
  let entry = existing ?? owned?.entry;
  if (!entry) {
    throw new Error("Code Moniker daemon did not provide a registry entry");
  }

  let client: CodeMonikerClient | undefined;
  try {
    client = await runtime.connect(entry, {
      clientName: options.clientName ?? "postgresql-workbench",
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    client?.close();
    if (existing && mayLaunch && (!options.daemon || isDaemonProtocolMismatch(error))) {
      try {
        owned = await runtime.restart(existing, launchOptions, { exitTimeoutMs: 10_000 });
      } catch {
        runtime.forgetDaemon(existing);
        owned = await runtime.launch(launchOptions);
      }
      entry = owned.entry;
      client = await runtime.connect(entry, {
        clientName: options.clientName ?? "postgresql-workbench",
        timeoutMs: options.timeoutMs,
      });
    } else if (owned) {
      await runtime.stopOwned(owned, { exitTimeoutMs: 10_000 }).catch(() => undefined);
      throw error;
    } else {
      throw error;
    }
  }
  return new LocalCodeMonikerSession(
    client,
    {
      runtimePath: packaged.rootPath,
      source: packaged.manifest.source,
      packageVersion: packaged.manifest.clientVersion,
      protocolVersion: clientModule.PROTOCOL_VERSION,
      binaryPath: packaged.binaryPath,
      daemonPid: entry.pid,
      ownedDaemon: owned !== undefined,
    },
    localDaemon(entry),
    runtime,
    owned,
  );
}

function isDaemonProtocolMismatch(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  return /daemon speaks protocol \d+, but the client expects \d+/i.test(message);
}

function localDaemon(entry: DaemonRegistryEntry): LocalCodeMonikerDaemon {
  return {
    endpoint: entry.endpoint,
    pid: entry.pid,
    token: entry.token,
    workspaceRoots: [...entry.workspace_roots],
  };
}

function daemonRegistryEntry(daemon: LocalCodeMonikerDaemon): DaemonRegistryEntry {
  return {
    endpoint: daemon.endpoint,
    pid: daemon.pid,
    token: daemon.token,
    workspace_roots: [...daemon.workspaceRoots],
  };
}
