import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchRuntime } from "../../runtime/src/index.js";

const id = z.string().uuid();
const oid = z.number().int().positive().max(4294967295);
const sql = z.string().min(1).max(100_000);
const mutation = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createWorkbenchMcp(
  runtime: WorkbenchRuntime,
  redact: (text: string) => string = (text) => text,
) {
  const server = new McpServer(
    { name: "postgresql-workbench", version: "0.1.0" },
    {
      instructions:
        "Use explicit session, scratchpad and observation ids. Observations are immutable process-local evidence; reading one never executes SQL. Execution and debug tools can modify the configured database. This server owns independent sessions and does not observe VS Code buffers or sessions. Call workbench_context first.",
    },
  );
  const result = async (action: () => unknown) => {
    try {
      const data: unknown = JSON.parse(JSON.stringify(await action()));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { data },
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: redact(error instanceof Error ? error.message : "Workbench operation failed"),
          },
        ],
      };
    }
  };
  server.registerTool(
    "workbench_context",
    {
      description:
        "List configured connection profiles, owned database sessions, scratchpads and retained evidence ids.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      result(() => ({
        connections: runtime.sessions.connections(),
        sessions: runtime.sessions.list(),
        scratchpads: runtime.scratchpads.list(),
        observations: runtime.evidence.list(),
      })),
  );
  server.registerTool(
    "session_open",
    {
      description:
        "Open an independent PostgreSQL session for a configured profile; returns the actual database, opening role and backend PID.",
      inputSchema: { profileId: z.string().min(1) },
      annotations: mutation,
    },
    ({ profileId }) => result(() => runtime.sessions.open(profileId)),
  );
  server.registerTool(
    "session_close",
    {
      description:
        "Close this session and its dedicated debug/coverage backends; retained evidence remains readable.",
      inputSchema: { sessionId: id },
      annotations: mutation,
    },
    ({ sessionId }) =>
      result(async () => {
        await runtime.closeSession(sessionId);
        return { closed: sessionId };
      }),
  );
  server.registerTool(
    "scratchpad_put",
    {
      description:
        "Create or replace an in-memory scratchpad. Edits require its id and exact current revision. Association cannot silently change.",
      inputSchema: {
        sessionId: id,
        cells: z.array(sql).min(1).max(20),
        scratchpadId: id.optional(),
        expectedRevision: z.number().int().positive().optional(),
      },
      annotations: mutation,
    },
    ({ sessionId, cells, scratchpadId, expectedRevision }) =>
      result(() => runtime.scratchpads.put(sessionId, cells, scratchpadId, expectedRevision)),
  );
  server.registerTool(
    "scratchpad_read",
    {
      description: "Read the current scratchpad content and revision without executing it.",
      inputSchema: { scratchpadId: id },
      annotations: readOnly,
    },
    ({ scratchpadId }) => result(() => runtime.scratchpads.read(scratchpadId)),
  );
  server.registerTool(
    "scratchpad_execute",
    {
      description:
        "Execute one exact scratchpad revision/cell on its bound session. One SQL statement per cell; PostgreSQL rejects batches before execution. May write data or DDL. Returns captured provenance and a bounded result or SQL error.",
      inputSchema: {
        scratchpadId: id,
        revision: z.number().int().positive(),
        cellIndex: z.number().int().min(0),
      },
      annotations: mutation,
    },
    ({ scratchpadId, revision, cellIndex }) =>
      result(() => runtime.scratchpads.execute(scratchpadId, revision, cellIndex)),
  );
  server.registerTool(
    "observation_read",
    {
      description:
        "Read retained execution, debug, coverage or catalog evidence without re-running it. Pages the serialized observation as UTF-16 text; concatenate chunks to recover its JSON.",
      inputSchema: {
        observationId: id,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100_000).default(32_000),
      },
      annotations: readOnly,
    },
    ({ observationId, offset, limit }) =>
      result(() => {
        const text = JSON.stringify(runtime.evidence.read(observationId));
        return {
          observationId,
          offset,
          totalCharacters: text.length,
          text: text.slice(offset, offset + limit),
          nextOffset: offset + limit < text.length ? offset + limit : null,
        };
      }),
  );
  server.registerTool(
    "observation_forget",
    {
      description: "Explicitly forget an observation to release retained memory.",
      inputSchema: { observationId: id },
      annotations: mutation,
    },
    ({ observationId }) =>
      result(() => {
        runtime.evidence.forget(observationId);
        return { forgotten: observationId };
      }),
  );
  server.registerTool(
    "catalog_refresh",
    {
      description:
        "Capture Workbench virtual DDL sources, foreign keys, view dependencies and structural changes since the previous explicit refresh. Does not install listeners or modify the database.",
      inputSchema: { sessionId: id },
      annotations: { ...mutation, destructiveHint: false },
    },
    ({ sessionId }) =>
      result(async () => {
        const { data: _data, ...observation } = await runtime.catalog.refresh(sessionId);
        return observation;
      }),
  );
  server.registerTool(
    "tests_discover",
    {
      description:
        "Discover runnable pgTAP tests and their source routine associations through Workbench SQL analysis.",
      inputSchema: { sessionId: id },
      annotations: readOnly,
    },
    ({ sessionId }) => result(() => runtime.coverage.discover(sessionId)),
  );
  server.registerTool(
    "coverage_run",
    {
      description:
        "Run selected pgTAP tests against selected PL/pgSQL routines with native coverage. Instrumentation runs on a dedicated connection and is rolled back. Tests may have nontransactional side effects.",
      inputSchema: {
        sessionId: id,
        routineOids: z.array(oid).min(1).max(20),
        testOids: z.array(oid).min(1).max(20),
      },
      annotations: mutation,
    },
    ({ sessionId, routineOids, testOids }) =>
      result(async () => {
        const { data: _data, ...observation } = await runtime.coverage.run(
          sessionId,
          routineOids,
          testOids,
        );
        return observation;
      }),
  );
  server.registerTool(
    "debug_start",
    {
      description:
        "Start PL/pgSQL debugging on a dedicated target backend and stop in routineOid. sql must be one statement invoking that routine and may write data. The breakpoint only targets this backend. Debug runs expire after five minutes.",
      inputSchema: { sessionId: id, routineOid: oid, sql },
      annotations: mutation,
    },
    ({ sessionId, routineOid, sql: text }) =>
      result(() => runtime.debug.start(sessionId, routineOid, text)),
  );
  server.registerTool(
    "debug_inspect",
    {
      description: "Capture the current debug stack, selected frame variables and routine sources.",
      inputSchema: { debugId: id, frame: z.number().int().min(0).default(0) },
      annotations: readOnly,
    },
    ({ debugId, frame }) => result(() => runtime.debug.inspect(debugId, frame)),
  );
  server.registerTool(
    "debug_step",
    {
      description:
        "Advance the same PL/pgSQL execution; returns a captured stop or the final result.",
      inputSchema: { debugId: id, action: z.enum(["over", "into", "continue"]) },
      annotations: mutation,
    },
    ({ debugId, action }) => result(() => runtime.debug.step(debugId, action)),
  );
  server.registerTool(
    "debug_breakpoint",
    {
      description: "Set or remove a line breakpoint in an existing debug run.",
      inputSchema: {
        debugId: id,
        routineOid: oid,
        line: z.number().int().positive(),
        enabled: z.boolean(),
      },
      annotations: mutation,
    },
    ({ debugId, routineOid, line, enabled }) =>
      result(() => runtime.debug.breakpoint(debugId, routineOid, line, enabled)),
  );
  server.registerTool(
    "debug_close",
    {
      description: "Close this debug run and its target backend, keeping captured observations.",
      inputSchema: { debugId: id },
      annotations: mutation,
    },
    ({ debugId }) =>
      result(async () => {
        await runtime.debug.close(debugId);
        return { closed: debugId };
      }),
  );
  return server;
}
