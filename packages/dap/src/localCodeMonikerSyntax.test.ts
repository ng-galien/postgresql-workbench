import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeMonikerSyntaxTree } from "../../sql/src/analysis/codeMonikerSyntax.js";
import {
  isWorkspaceBusy,
  SerialTaskQueue,
  SYNTAX_WORKER_SHUTDOWN_BUDGET_MS,
  stopSyntaxWorker,
  syntaxReadArguments,
  syntaxTreeFromToolResult,
} from "../../sql/src/localCodeMonikerSyntax.js";
import { TIMEOUTS } from "./debugger/session/PlpgsqlDebugSession.js";

describe("stateless Code Moniker syntax boundary", () => {
  it("keeps the process hard-exit budget above every bounded teardown path", () => {
    expect(TIMEOUTS.SHUTDOWN_BUDGET_MS).toBeGreaterThan(SYNTAX_WORKER_SHUTDOWN_BUDGET_MS);
    expect(TIMEOUTS.SHUTDOWN_BUDGET_MS).toBeGreaterThan(
      TIMEOUTS.ABORT_MS + TIMEOUTS.TARGET_DRAIN_MS + TIMEOUTS.CLOSE_MS,
    );
  });

  it("builds only a stateless syntax.parse query", () => {
    const arguments_ = syntaxReadArguments({
      language: "plpgsql",
      source: 'BEGIN\n  RAISE NOTICE "hello";\nEND',
      uri: "debugger.plpgsql",
      maxDepth: 32,
      maxNodes: 2_000,
      namedOnly: false,
    });

    expect(arguments_).toMatchObject({
      ast: true,
      format: "json",
      language: "plpgsql",
      uri: "debugger.plpgsql",
      named_only: false,
    });
    expect(Object.keys(arguments_)).not.toEqual(
      expect.arrayContaining(["workspace", "symbols", "graph", "usages", "sources"]),
    );
  });

  it("extracts the structured syntax tree from the MCP result", () => {
    const tree = syntaxTreeFromToolResult({
      structuredContent: syntaxTreeResult(),
      isError: false,
    });

    expect(tree.language).toBe("sql");
    expect(tree.root.kind).toBe("source_file");
  });

  it("preserves typed language, flags, and UTF-8 byte ranges", () => {
    const result = syntaxTreeResult();
    result.root.children = [
      {
        kind: "injected",
        language: "plpgsql",
        named: false,
        error: true,
        missing: true,
        byte_range: [0, 2],
        start: { line: 1, column: 0 },
        end: { line: 1, column: 2 },
        text: null,
        children: [],
      },
    ];
    result.emitted_nodes = 2;
    result.total_nodes = 2;
    const tree = syntaxTreeFromToolResult({ structuredContent: result, isError: false });

    expect(tree.root.children).toEqual([
      expect.objectContaining({
        kind: "injected",
        language: "plpgsql",
        named: false,
        error: true,
        missing: true,
        byte_range: [0, 2],
      }),
    ]);
  });

  it("waits for a forced worker exit before removing its temporary root", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "postgresql-dap-stop-test-"));
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    await new Promise((resolveStart) => setTimeout(resolveStart, 50));
    await stopSyntaxWorker(child, temporaryDirectory, 20, 20, 2_000);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  it("rejects presentation text and malformed structured output", () => {
    expect(() =>
      syntaxTreeFromToolResult({ content: [{ type: "text", text: "# Syntax tree" }] }),
    ).toThrow(/invalid structured syntax response/);
    expect(() => syntaxTreeFromToolResult({ structuredContent: { file: "snippet.sql" } })).toThrow(
      /invalid structured syntax response/,
    );
  });

  it("recognizes and reports workspace_busy from structured JSON errors", () => {
    const result = {
      content: [],
      structuredContent: {
        problem:
          "workspace_busy: this stdio-worker is applying an exclusive mutation; a detached daemon is an independent runtime",
        fix_hint: "Retry with a supported URI and bounded arguments.",
        tool: "code_moniker_read",
        uri: "document.sql",
      },
      isError: true,
    };

    expect(isWorkspaceBusy(result)).toBe(true);
    expect(() => syntaxTreeFromToolResult(result)).toThrow(
      /workspace_busy: this stdio-worker is applying an exclusive mutation/,
    );
  });

  it("serializes MCP work and continues the queue after a failure", async () => {
    const queue = new SerialTaskQueue();
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    let secondStarted = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstOutcome = queue
      .run(async () => {
        activeTasks++;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        await firstGate;
        activeTasks--;
        throw new Error("first parse failed");
      })
      .catch((error: unknown) => error);
    const second = queue.run(async () => {
      secondStarted = true;
      activeTasks++;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      activeTasks--;
      return "second parse completed";
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();

    await expect(firstOutcome).resolves.toEqual(new Error("first parse failed"));
    await expect(second).resolves.toBe("second parse completed");
    expect(maximumActiveTasks).toBe(1);
  });
});

function syntaxTreeResult(): CodeMonikerSyntaxTree {
  return {
    file: "debugger.sql",
    language: "sql",
    focus: "debugger.sql",
    focus_line_range: null,
    root: {
      kind: "source_file",
      language: null,
      named: true,
      error: false,
      missing: false,
      byte_range: [0, 8] as [number, number],
      start: { line: 1, column: 0 },
      end: { line: 1, column: 8 },
      text: null,
      children: [],
    },
    emitted_nodes: 1,
    total_nodes: 1,
    max_depth: 1,
    truncated: false,
    has_error: false,
  };
}
