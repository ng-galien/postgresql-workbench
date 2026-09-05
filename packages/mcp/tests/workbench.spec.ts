import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { Observation } from "../../runtime/src/evidence.js";

let client: Client;
let transport: StdioClientTransport;
let stderr: string;

test.beforeEach(async () => {
  stderr = "";
  client = new Client({ name: "workbench-acceptance", version: "1" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.PGWB_MCP_PROFILES;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/server.cjs"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await client.connect(transport);
});

test.afterEach(async () => {
  await client.close();
  expect(stderr).not.toContain(process.env.PGPASSWORD!);
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent?.data;
}

async function open(): Promise<string> {
  return (await call("session_open", { profileId: "default" })).id;
}

async function execute(sessionId: string, sql: string): Promise<any> {
  const scratchpad = await call("scratchpad_put", { sessionId, cells: [sql] });
  return call("scratchpad_execute", {
    scratchpadId: scratchpad.id,
    revision: scratchpad.revision,
    cellIndex: 0,
  });
}

async function observation(id: string): Promise<Observation> {
  let offset: number | null = 0;
  let text = "";
  do {
    const page = await call("observation_read", { observationId: id, offset });
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(text) as Observation;
}

test("retains the exact scratchpad execution after edits and session closure, without re-executing", async () => {
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(16);
  expect(
    tools.tools.find((tool) => tool.name === "scratchpad_execute")?.annotations?.readOnlyHint,
  ).toBe(false);
  const sessionId = await open();
  await execute(sessionId, "CREATE TEMP TABLE mcp_counter(value integer)");
  const pad = await call("scratchpad_put", {
    sessionId,
    cells: ["INSERT INTO mcp_counter VALUES (1) RETURNING value"],
  });
  const original = await call("scratchpad_execute", {
    scratchpadId: pad.id,
    revision: 1,
    cellIndex: 0,
  });
  expect(original.data.status).toBe("completed");
  expect(original.data.result.rows[0][0].value).toBe("1");
  await call("scratchpad_put", {
    sessionId,
    scratchpadId: pad.id,
    expectedRevision: 1,
    cells: ["SELECT 2"],
  });
  const stale = await client.callTool({
    name: "scratchpad_execute",
    arguments: { scratchpadId: pad.id, revision: 1, cellIndex: 0 },
  });
  expect(stale.isError).toBe(true);
  expect(await observation(original.id)).toEqual(original);
  expect(await observation(original.id)).toEqual(original);
  const count = await execute(sessionId, "SELECT count(*) FROM mcp_counter");
  expect(count.data.result.rows[0][0].value).toBe("1");
  await call("session_close", { sessionId });
  expect(await observation(original.id)).toEqual(original);
  const closed = await client.callTool({
    name: "scratchpad_execute",
    arguments: { scratchpadId: pad.id, revision: 2, cellIndex: 0 },
  });
  expect(closed.isError).toBe(true);
});

test("captures errors, bounds rows and keeps PostgreSQL sessions isolated", async () => {
  const first = await open();
  const second = await open();
  await execute(first, "CREATE TEMP TABLE mcp_private(value integer)");
  const failure = await execute(second, "SELECT * FROM mcp_private");
  expect(failure.data.status).toBe("failed");
  expect(failure.data.error.code).toBe("42P01");
  expect(await observation(failure.id)).toEqual(failure);
  const rows = await execute(first, "SELECT generate_series(1, 500)");
  expect(rows.data.result.capturedRowCount).toBe(200);
  expect(rows.data.result.truncated).toBe(true);
  expect(rows.data.result.rowCount).toBe(500);
  const pad = await call("scratchpad_put", { sessionId: first, cells: ["SELECT pg_sleep(0.5)"] });
  const pending = call("scratchpad_execute", { scratchpadId: pad.id, revision: 1, cellIndex: 0 });
  await expect
    .poll(
      async () =>
        (await call("workbench_context")).sessions.find((session: any) => session.id === first)
          .busy,
    )
    .toBe(true);
  const busy = await client.callTool({
    name: "scratchpad_execute",
    arguments: { scratchpadId: pad.id, revision: 1, cellIndex: 0 },
  });
  expect(busy.isError).toBe(true);
  await pending;
});

test("observes structural DDL changes without reacting to DML", async () => {
  const sessionId = await open();
  const schema = `mcp_${sessionId.replaceAll("-", "")}`;
  try {
    await execute(sessionId, `CREATE SCHEMA ${schema}`);
    const initial = await call("catalog_refresh", { sessionId });
    expect((await observation(initial.id)).kind).toBe("catalog");
    await execute(sessionId, `CREATE TABLE ${schema}.items(id integer PRIMARY KEY)`);
    const changed: any = await observation((await call("catalog_refresh", { sessionId })).id);
    expect(changed.data.changes.added.length).toBeGreaterThan(0);
    expect(changed.data.documents.some((doc: any) => doc.postgres?.name === "items")).toBe(true);
    await execute(sessionId, `INSERT INTO ${schema}.items VALUES (1)`);
    const dml: any = await observation((await call("catalog_refresh", { sessionId })).id);
    expect(dml.data.changes).toEqual({ initial: false, added: [], changed: [], removed: [] });
  } finally {
    await execute(sessionId, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
});

test("debugs a real PL/pgSQL target with stack, variables and captured completion", async () => {
  const sessionId = await open();
  const oidResult = await execute(
    sessionId,
    "SELECT 'public.test_simple(integer,text)'::regprocedure::oid",
  );
  const routineOid = Number(oidResult.data.result.rows[0][0].value);
  const stopped = await call("debug_start", {
    sessionId,
    routineOid,
    sql: "SELECT public.test_simple(4, 'mcp')",
  });
  expect(stopped.data.status).toBe("stopped");
  expect(stopped.data.stack.length).toBeGreaterThan(0);
  expect(stopped.data.sources[0].source).toContain("test_simple");
  const debugId = stopped.data.debugId;
  const otherSession = await open();
  const other = await execute(otherSession, "SELECT public.test_simple(8, 'other')");
  expect(other.data.result.rows[0][0].value).toBe("other - 9");
  const inspected = await call("debug_inspect", { debugId });
  expect(inspected.data.variables.length).toBeGreaterThan(0);
  await call("debug_step", { debugId, action: "over" });
  const finished = await call("debug_step", { debugId, action: "continue" });
  expect(finished.data.status).toBe("completed");
  expect(finished.data.result.rows[0][0].value).toBe("mcp - 5");
  await call("debug_close", { debugId });
  expect(await observation(stopped.id)).toEqual(stopped);
});

test("runs native coverage and retains the source-linked campaign report", async () => {
  const sessionId = await open();
  const discovery = await call("tests_discover", { sessionId });
  expect(discovery.available).toBe(true);
  const selected = discovery.tests.find((item: any) => item.name === "test_coverage_subject");
  expect(selected).toBeTruthy();
  const oidResult = await execute(
    sessionId,
    "SELECT 'public.coverage_subject(integer)'::regprocedure::oid",
  );
  const routineOid = Number(oidResult.data.result.rows[0][0].value);
  const captured = await call("coverage_run", {
    sessionId,
    routineOids: [routineOid],
    testOids: [selected.oid],
  });
  const report: any = await observation(captured.id);
  expect(report.data.report.state).toBe("completed");
  expect(report.data.report.tests.failed).toBe(0);
  expect(report.data.report.tests.passed).toBeGreaterThan(0);
  expect(report.data.report.routines[0].routine.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.data.report.routines[0].coverage.statement.covered).toBeGreaterThan(0);
  expect(report.data.report.routines[0].coverage.branch.covered).toBeGreaterThan(0);
  const unchanged = await execute(sessionId, "SELECT public.coverage_subject(3)");
  expect(unchanged.data.result.rows[0][0].value).toBe("6");
});

test("rejects multiple statements before their side effects", async () => {
  const sessionId = await open();
  await execute(sessionId, "CREATE TEMP TABLE mcp_multi(value integer)");
  const multiple = await execute(
    sessionId,
    "INSERT INTO mcp_multi VALUES (1); SELECT 'second' AS other",
  );
  expect(multiple.data.status).toBe("failed");
  expect(multiple.data.error.code).toBe("42601");
  const count = await execute(sessionId, "SELECT count(*) FROM mcp_multi");
  expect(count.data.result.rows[0][0].value).toBe("0");
});

test("distinguishes the opening role from a changed effective role", async () => {
  const sessionId = await open();
  await execute(sessionId, "SET ROLE pg_read_all_data");
  const changed = await execute(sessionId, "SELECT current_user");
  expect(changed.data.context).not.toHaveProperty("user");
  expect(changed.data.result.rows[0][0].value).toBe("pg_read_all_data");
  expect(changed.data.context.openedAsRole).toBe(process.env.PGUSER);
  await execute(sessionId, "RESET ROLE");
});

test("preserves transaction setup without injecting a query after BEGIN", async () => {
  const sessionId = await open();
  try {
    expect((await execute(sessionId, "BEGIN")).data.status).toBe("completed");
    const isolation = await execute(sessionId, "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(isolation.data.status).toBe("completed");
    const current = await execute(sessionId, "SHOW transaction_isolation");
    expect(current.data.result.rows[0][0].value).toBe("serializable");
  } finally {
    await execute(sessionId, "ROLLBACK");
  }
});

test("closes an open database session on stdin EOF without a termination signal", async () => {
  const child = spawn(process.execPath, ["dist/mcp/server.cjs"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const response = () =>
    new Promise<any>((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
  try {
    const initialized = response();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "eof-proof", version: "1" } } })}\n`,
    );
    expect((await initialized).result.serverInfo.name).toBe("postgresql-workbench");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const opened = response();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_open", arguments: { profileId: "default" } } })}\n`,
    );
    expect((await opened).result.structuredContent.data.state).toBe("open");
    child.stdin.end();
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
