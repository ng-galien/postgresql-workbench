import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIMEOUTS } from "./debugger/session/PlpgsqlDebugSession.js";
import {
  SYNTAX_WORKER_SHUTDOWN_BUDGET_MS,
  stopSyntaxWorker,
  syntaxReadArguments,
  syntaxTreeFromToolResult,
} from "./localCodeMonikerSyntax.js";

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
      language: "plpgsql",
      uri: "debugger.plpgsql",
      named_only: false,
    });
    expect(Object.keys(arguments_)).not.toEqual(
      expect.arrayContaining(["workspace", "symbols", "graph", "usages", "sources"]),
    );
  });

  it("extracts the raw syntax tree from the bounded MCP result", () => {
    const tree = syntaxTreeFromToolResult(
      {
        content: [
          {
            type: "text",
            text: `uri: syntax.parse
completeness: bounded
file: debugger.sql
language: sql
focus: debugger.sql
nodes: 2/2 max_depth:1 parse_error:false
tree:
- source_file 1:0-1:8
  - toplevel_stmt 1:0-1:8
`,
          },
        ],
        isError: false,
      },
      "SELECT 1",
    );

    expect(tree.language).toBe("sql");
    expect(tree.root.kind).toBe("source_file");
  });

  it("preserves language, flags, and UTF-8 byte ranges from compact AST output", () => {
    const tree = syntaxTreeFromToolResult(
      {
        content: [
          {
            type: "text",
            text: `uri: syntax.parse
completeness: full
file: debugger.plpgsql
language: plpgsql
focus: debugger.plpgsql
nodes: 2/2 max_depth:1 parse_error:true
tree:
- source_file 1:0-1:2
  - injected 1:0-1:2 [plpgsql,anonymous,error,missing]
`,
          },
        ],
        isError: false,
      },
      "é",
    );

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

  it("fails closed on truncated MCP output", () => {
    expect(() =>
      syntaxTreeFromToolResult(
        {
          content: [{ type: "text", text: "… output omitted" }],
        },
        "SELECT 1",
      ),
    ).toThrow(/truncated the syntax tree/);
  });
});
