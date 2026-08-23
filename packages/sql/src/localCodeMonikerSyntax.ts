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
const MAX_MCP_RESPONSE_CHARS = 100_000;
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

  async parse(request: Record<string, unknown>): Promise<CodeMonikerSyntaxTree> {
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
    return syntaxTreeFromToolResult(result, source);
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

export function syntaxTreeFromToolResult(
  result: McpToolResult,
  source: string,
): CodeMonikerSyntaxTree {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError || !text) {
    const detail = text?.trim();
    throw new Error(
      detail ? `Code Moniker syntax parse failed: ${detail}` : "Code Moniker syntax parse failed",
    );
  }
  if (text.includes("… output omitted")) throw new Error("Code Moniker truncated the syntax tree");
  const file = headerValue(text, "file");
  const language = headerValue(text, "language");
  const focus = headerValue(text, "focus");
  const summary = /^nodes:\s+(\d+)\/(\d+)\s+max_depth:(\d+)\s+parse_error:(true|false)$/m.exec(
    text,
  );
  if (!file || !language || !focus || !summary) {
    throw new Error("Code Moniker returned an invalid syntax response");
  }
  const emittedNodes = Number(summary[1]);
  const totalNodes = Number(summary[2]);
  const sourceBuffer = Buffer.from(source, "utf8");
  const lineStarts = sourceLineStarts(sourceBuffer);
  const stack: CodeMonikerSyntaxTree["root"][] = [];
  let root: CodeMonikerSyntaxTree["root"] | undefined;
  let parsedNodes = 0;
  for (const line of text.slice(text.indexOf("\ntree:") + 7).split("\n")) {
    const match = /^(\s*)-\s+(\S+)\s+(\d+):(\d+)-(\d+):(\d+)(?:\s+\[([^\]]+)\])?$/.exec(line);
    if (!match) continue;
    const depth = Math.floor(match[1].length / 2);
    const kind = match[2];
    const flags = new Set((match[7] ?? "").split(",").map((flag) => flag.trim()));
    const nodeLanguage = [...flags].find((flag) => flag === "sql" || flag === "plpgsql");
    const node: CodeMonikerSyntaxTree["root"] = {
      kind,
      language: nodeLanguage ?? null,
      named: !flags.has("anonymous"),
      error: kind === "ERROR" || flags.has("error"),
      missing: kind.startsWith("MISSING") || flags.has("missing"),
      byte_range: [
        sourceByteOffset(lineStarts, sourceBuffer.length, Number(match[3]), Number(match[4])),
        sourceByteOffset(lineStarts, sourceBuffer.length, Number(match[5]), Number(match[6])),
      ],
      start: { line: Number(match[3]), column: Number(match[4]) },
      end: { line: Number(match[5]), column: Number(match[6]) },
      text: null,
      children: [],
    };
    const parent = stack[depth - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    stack.length = depth;
    stack[depth] = node;
    parsedNodes++;
  }
  if (!root || parsedNodes !== emittedNodes) {
    throw new Error(
      `Code Moniker syntax tree is incomplete: parsed ${parsedNodes} of ${emittedNodes} emitted nodes`,
    );
  }
  return {
    file,
    language,
    focus,
    focus_line_range: null,
    root,
    emitted_nodes: emittedNodes,
    total_nodes: totalNodes,
    max_depth: Number(summary[3]),
    truncated: emittedNodes < totalNodes,
    has_error: summary[4] === "true",
  };
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
    compact: true,
    budget: "full",
    max_chars: MAX_MCP_RESPONSE_CHARS,
  };
}

function headerValue(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s+(.+)$`, "m").exec(text);
  return match?.[1].trim();
}

function sourceLineStarts(source: Buffer): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function sourceByteOffset(
  lineStarts: readonly number[],
  sourceLength: number,
  oneBasedLine: number,
  column: number,
): number {
  const lineStart = lineStarts[oneBasedLine - 1];
  if (lineStart === undefined) return sourceLength;
  return Math.min(lineStart + column, sourceLength);
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

function isWorkspaceBusy(result: McpToolResult): boolean {
  return (
    result.isError === true &&
    result.content?.some(
      (item) => item.type === "text" && item.text?.includes("problem: workspace_busy"),
    ) === true
  );
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
