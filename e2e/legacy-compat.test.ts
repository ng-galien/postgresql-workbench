/**
 * Compatibility contract for the unpatched EnterpriseDB pldebugger.
 *
 * Upstream v1.9 only publishes PLPGSQL_DTYPE_VAR values. Records, rows, and
 * record fields may therefore be absent, but they must never make the DAP
 * session or the remaining scalar-variable inspection fail.
 */

import * as path from "node:path";
import { DebugClient } from "@vscode/debugadapter-testsupport";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

const DAP_SERVER = path.resolve(__dirname, "../dist/main.js");
const LAUNCH_ARGS = {
  host: "localhost",
  port: 5435,
  database: "legacydb",
  user: "postgres",
  password: "postgres",
};
let canonicalSourceUris: Record<string, string> = {};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchAndWaitForStop(dc: DebugClient, sql: string) {
  const stopped = dc.waitForEvent("stopped", 15_000);
  await Promise.all([
    dc.launch({ ...LAUNCH_ARGS, sourceUris: canonicalSourceUris, sql }),
    dc.configurationSequence(),
  ]);
  return stopped;
}

async function runAndWaitForStop(dc: DebugClient, action: () => Promise<unknown>) {
  const stopped = dc.waitForEvent("stopped", 15_000);
  await action();
  return stopped;
}

describe("DAP compatibility with upstream EnterpriseDB pldebugger", () => {
  let dc: DebugClient;
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
    canonicalSourceUris = await codeMoniker.sourceUris(LAUNCH_ARGS);
  }, 30_000);

  afterAll(async () => {
    await codeMoniker.dispose();
  });

  beforeEach(async () => {
    dc = new DebugClient("node", DAP_SERVER, "plpgsql", {
      env: codeMoniker.dapEnvironment(),
    });
    await dc.start();
  });

  afterEach(async () => {
    try {
      await Promise.race([dc.stop(), delay(3_000)]);
    } catch {
      // The session may already be closed.
    }
  }, 10_000);

  it("keeps scalar argument and local inspection functional", async () => {
    const stopped = await launchAndWaitForStop(dc, "SELECT test_simple(41, 'legacy')");
    const threadId = stopped.body.threadId;

    const initialStack = await dc.stackTraceRequest({ threadId });
    const initialScopes = await dc.scopesRequest({
      frameId: initialStack.body.stackFrames[0].id,
    });
    const args = await dc.variablesRequest({
      variablesReference: initialScopes.body.scopes[0].variablesReference,
    });
    expect(args.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "a", value: "41" }),
        expect.objectContaining({ name: "b", value: "legacy" }),
      ]),
    );

    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId }));

    const steppedStack = await dc.stackTraceRequest({ threadId });
    const steppedScopes = await dc.scopesRequest({
      frameId: steppedStack.body.stackFrames[0].id,
    });
    const locals = await dc.variablesRequest({
      variablesReference: steppedScopes.body.scopes[1].variablesReference,
    });
    expect(locals.body.variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "counter", value: "42" })]),
    );

    await dc.disconnectRequest();
  });

  it("does not fail when the legacy extension omits a composite variable", async () => {
    const stopped = await launchAndWaitForStop(dc, "SELECT test_record_var()");
    const threadId = stopped.body.threadId;

    for (let i = 0; i < 3; i++) {
      await runAndWaitForStop(dc, () => dc.nextRequest({ threadId }));
    }

    const stack = await dc.stackTraceRequest({ threadId });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });

    expect(locals.success).not.toBe(false);
    expect(locals.body.variables).toEqual([]);

    await dc.disconnectRequest();
  });

  it("keeps scalar inspection alive when an anonymous record is omitted", async () => {
    const stopped = await launchAndWaitForStop(dc, "SELECT test_anonymous_record()");
    const threadId = stopped.body.threadId;

    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId }));

    const stack = await dc.stackTraceRequest({ threadId });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });

    expect(locals.success).not.toBe(false);
    expect(locals.body.variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "marker", type: "integer" })]),
    );
    expect(locals.body.variables.find((variable) => variable.name === "rec")).toBeUndefined();

    await dc.disconnectRequest();
  });
});
