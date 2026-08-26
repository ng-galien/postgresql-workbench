import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CodeMonikerSyntaxTree,
  createCodeMonikerSyntaxParser,
} from "./analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "./analysis/syntaxTree.js";

const moduleRequire = createRequire(__filename);
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;
const WORKSPACE_BUSY_RETRY_COUNT = 20;
const WORKSPACE_BUSY_RETRY_DELAY_MS = 50;
const WORKER_GRACEFUL_TIMEOUT_MS = 2_000;
const WORKER_TERMINATE_TIMEOUT_MS = 2_000;
const WORKER_KILL_TIMEOUT_MS = 1_000;
export const SYNTAX_WORKER_SHUTDOWN_BUDGET_MS =
  WORKER_GRACEFUL_TIMEOUT_MS + WORKER_TERMINATE_TIMEOUT_MS + WORKER_KILL_TIMEOUT_MS;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface StatelessCodeMonikerSyntaxOptions {
  runtimePath?: string;
  timeoutMs?: number;
}

/**
 * Lazy, process-owned Code Moniker syntax worker.
 *
 * It serves only stateless SQL/PL/pgSQL parsing over MCP stdio. It never opens
 * a workspace daemon, registry, source set, symbol index, graph, or navigation API.
 */
export class StatelessCodeMonikerSyntaxRuntime {
  private workerPromise: Promise<CodeMonikerSyntaxWorker> | undefined;
  private parserPromise: Promise<SyntaxParser> | undefined;

  constructor(private readonly options: StatelessCodeMonikerSyntaxOptions = {}) {}

  parser(): Promise<SyntaxParser> {
    if (!this.parserPromise) {
      this.parserPromise = this.worker().then((worker) =>
        createCodeMonikerSyntaxParser({
          queryData: (request) => worker.parse(request),
        }),
      );
    }
    return this.parserPromise;
  }

  async dispose(): Promise<void> {
    const pending = this.workerPromise;
    this.workerPromise = undefined;
    this.parserPromise = undefined;
    if (pending)
      await pending.then(
        (worker) => worker.dispose(),
        () => undefined,
      );
  }

  private worker(): Promise<CodeMonikerSyntaxWorker> {
    if (!this.workerPromise) {
      const pending = CodeMonikerSyntaxWorker.start(this.options).catch((error) => {
        if (this.workerPromise === pending) this.workerPromise = undefined;
        throw error;
      });
      this.workerPromise = pending;
    }
    return this.workerPromise;
  }
}

class CodeMonikerSyntaxWorker {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly parseQueue = new SerialTaskQueue();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private disposed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly temporaryDirectory: string,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => this.rejectPending(error));
    child.once("exit", (code, signal) => {
      this.rejectPending(
        new Error(
          `Code Moniker syntax worker exited (${code ?? signal ?? "unknown"})${this.stderrDiagnostic()}`,
        ),
      );
    });
  }

  static async start(options: StatelessCodeMonikerSyntaxOptions): Promise<CodeMonikerSyntaxWorker> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "postgresql-dap-syntax-"));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(codeMonikerBinary(options.runtimePath), [
      "mcp",
      "--transport",
      "stdio",
      "--live-refresh",
      "on-demand",
      temporaryDirectory,
    ]);
    const worker = new CodeMonikerSyntaxWorker(child, temporaryDirectory, timeoutMs);
    try {
      await worker.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "postgresql-dap", version: "1" },
      });
      worker.notify("notifications/initialized", {});
      return worker;
    } catch (error) {
      await worker.dispose();
      throw error;
    }
  }

  parse(request: Record<string, unknown>): Promise<CodeMonikerSyntaxTree> {
    return this.parseQueue.run(() => this.parseExclusive(request));
  }

  private async parseExclusive(request: Record<string, unknown>): Promise<CodeMonikerSyntaxTree> {
    const language = requiredString(request.language, "language");
    const source = requiredString(request.source, "source");
    const arguments_ = syntaxReadArguments({
      language,
      source,
      uri: optionalString(request.uri),
      maxDepth: optionalInteger(request.max_depth) ?? 32,
      maxNodes: optionalInteger(request.max_nodes) ?? 2_000,
      namedOnly: optionalBoolean(request.named_only) ?? false,
    });
    let result: McpToolResult | undefined;
    for (let attempt = 0; attempt < WORKSPACE_BUSY_RETRY_COUNT; attempt++) {
      result = (await this.request("tools/call", {
        name: "code_moniker_read",
        arguments: arguments_,
      })) as McpToolResult;
      if (!isWorkspaceBusy(result)) break;
      await delay(WORKSPACE_BUSY_RETRY_DELAY_MS);
    }
    if (!result) throw new Error("Code Moniker syntax parse produced no result");
    return syntaxTreeFromToolResult(result);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new Error("Code Moniker syntax worker was disposed"));
    await stopSyntaxWorker(this.child, this.temporaryDirectory);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Code Moniker syntax worker is disposed"));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Code Moniker syntax request ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "Code Moniker MCP request failed"));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private stderrDiagnostic(): string {
    const stderr = this.stderrTail.trim();
    return stderr ? `: ${stderr}` : "";
  }
}

/** @internal Exported so the MCP worker's serialization contract can be tested directly. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(task);
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

export function syntaxTreeFromToolResult(result: McpToolResult): CodeMonikerSyntaxTree {
  if (result.isError) {
    const detail = toolResultErrorDetail(result);
    throw new Error(
      detail ? `Code Moniker syntax parse failed: ${detail}` : "Code Moniker syntax parse failed",
    );
  }
  if (!isCodeMonikerSyntaxTree(result.structuredContent)) {
    throw new Error("Code Moniker returned an invalid structured syntax response");
  }
  return result.structuredContent;
}

export function syntaxReadArguments(request: {
  language: string;
  source: string;
  uri?: string;
  maxDepth: number;
  maxNodes: number;
  namedOnly: boolean;
}): Record<string, unknown> {
  return {
    source: request.source,
    language: request.language,
    ast: true,
    ...(request.uri ? { uri: request.uri } : {}),
    max_depth: request.maxDepth,
    max_nodes: request.maxNodes,
    named_only: request.namedOnly,
    include_text: false,
    max_text_chars: 0,
    format: "json",
    compact: true,
    budget: "full",
  };
}

function isCodeMonikerSyntaxTree(value: unknown): value is CodeMonikerSyntaxTree {
  if (!isRecord(value)) return false;
  return (
    typeof value.file === "string" &&
    typeof value.language === "string" &&
    typeof value.focus === "string" &&
    isOptionalLineRange(value.focus_line_range) &&
    isCodeMonikerSyntaxNode(value.root) &&
    isNonNegativeInteger(value.emitted_nodes) &&
    isNonNegativeInteger(value.total_nodes) &&
    isNonNegativeInteger(value.max_depth) &&
    typeof value.truncated === "boolean" &&
    typeof value.has_error === "boolean"
  );
}

function isCodeMonikerSyntaxNode(value: unknown): value is CodeMonikerSyntaxTree["root"] {
  if (!isRecord(value)) return false;
  return (
    typeof value.kind === "string" &&
    (value.language === undefined ||
      value.language === null ||
      typeof value.language === "string") &&
    typeof value.named === "boolean" &&
    typeof value.error === "boolean" &&
    typeof value.missing === "boolean" &&
    isIntegerPair(value.byte_range) &&
    isSyntaxPoint(value.start) &&
    isSyntaxPoint(value.end) &&
    (value.text === undefined || value.text === null || typeof value.text === "string") &&
    Array.isArray(value.children) &&
    value.children.every(isCodeMonikerSyntaxNode)
  );
}

function isSyntaxPoint(value: unknown): boolean {
  return isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.column);
}

function isOptionalLineRange(value: unknown): boolean {
  return value === undefined || value === null || isIntegerPair(value);
}

function isIntegerPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNonNegativeInteger);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codeMonikerBinary(runtimePath?: string): string {
  if (runtimePath) {
    const manifest = JSON.parse(readFileSync(resolve(runtimePath, "manifest.json"), "utf8")) as {
      binary?: unknown;
    };
    if (typeof manifest.binary !== "string") {
      throw new Error("The packaged Code Moniker runtime manifest has no binary");
    }
    return resolve(runtimePath, manifest.binary);
  }
  const clientRequire = createRequire(moduleRequire.resolve("@code-moniker/client"));
  const target = `${process.platform}-${process.arch}`;
  const binaryPackages: Record<string, [string, string]> = {
    "darwin-arm64": ["@code-moniker/cli-darwin-arm64", "code-moniker"],
    "darwin-x64": ["@code-moniker/cli-darwin-x64", "code-moniker"],
    "linux-x64": ["@code-moniker/cli-linux-x64", "code-moniker"],
    "win32-x64": ["@code-moniker/cli-win32-x64", "code-moniker.exe"],
  };
  const binaryPackage = binaryPackages[target];
  if (!binaryPackage) {
    throw new Error(`Code Moniker does not publish a runtime for ${target}`);
  }
  return clientRequire.resolve(`${binaryPackage[0]}/bin/${binaryPackage[1]}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Code Moniker syntax ${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** @internal Exported so the structured MCP retry contract can be tested directly. */
export function isWorkspaceBusy(result: McpToolResult): boolean {
  return (
    result.isError === true &&
    (structuredProblem(result)?.startsWith("workspace_busy") === true ||
      result.content?.some(
        (item) => item.type === "text" && item.text?.includes("problem: workspace_busy"),
      ) === true)
  );
}

function toolResultErrorDetail(result: McpToolResult): string | undefined {
  const problem = structuredProblem(result);
  if (problem) return problem;
  return result.content?.find((item) => item.type === "text")?.text?.trim() || undefined;
}

function structuredProblem(result: McpToolResult): string | undefined {
  if (!isRecord(result.structuredContent)) return undefined;
  const problem = result.structuredContent.problem;
  return typeof problem === "string" ? problem.trim() || undefined : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** @internal Exported only so the forced-shutdown path can be tested deterministically. */
export async function stopSyntaxWorker(
  child: ChildProcessWithoutNullStreams,
  temporaryDirectory: string,
  gracefulTimeoutMs = WORKER_GRACEFUL_TIMEOUT_MS,
  killTimeoutMs = WORKER_TERMINATE_TIMEOUT_MS,
  forcedKillTimeoutMs = WORKER_KILL_TIMEOUT_MS,
): Promise<void> {
  try {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await waitForExit(child, gracefulTimeoutMs);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child, killTimeoutMs);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, forcedKillTimeoutMs);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}
