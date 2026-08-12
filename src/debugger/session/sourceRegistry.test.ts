import { describe, expect, it } from "vitest";
import {
  clientSourceUris,
  standaloneSourceIdentity,
  standaloneSourceOid,
  standaloneSourceUri,
} from "./sourceRegistry.js";

const SYMBOL =
  "code+moniker://./srcset:test/lang:sql/dir:public/dir:routine/module:demo%28integer%29/schema:public/function:demo%28integer%29";
const DOCUMENT = `code+moniker://postgresql/testdb/public/function/demo(integer)?${encodeURIComponent(
  JSON.stringify({ identity: SYMBOL, label: "testdb/public/function/demo(integer)" }),
)}`;

describe("DAP client source registry", () => {
  it("preserves the exact caller-supplied canonical URI", () => {
    expect(clientSourceUris({ 42: SYMBOL }).get(42)).toBe(SYMBOL);
  });

  it("preserves a human document URI while validating its canonical identity", () => {
    expect(clientSourceUris({ 42: DOCUMENT }).get(42)).toBe(DOCUMENT);
  });

  it("accepts a missing indexed registry for a standalone DAP client", () => {
    const context = {
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      sessionId: "session-1",
    };
    expect(clientSourceUris(undefined)).toEqual(new Map());
    expect(standaloneSourceUri(42, context, "public.demo")).toBe(
      "postgresql-dap://postgresql/localhost/5433/testdb/postgres/session/session-1/routine/42/public.demo",
    );
    expect(new URL(standaloneSourceUri(42, context, "public.demo")).hostname).toBe("postgresql");
    const documentUri = standaloneSourceUri(42, context, "public.demo");
    expect(standaloneSourceOid(documentUri)).toBe(42);
    expect(standaloneSourceOid(documentUri, context)).toBe(42);
    expect(standaloneSourceIdentity(documentUri)).toEqual({
      context,
      oid: 42,
      sourceName: "public.demo",
    });
    expect(standaloneSourceOid("postgresql-dap:/routine/42")).toBeUndefined();
    expect(
      standaloneSourceOid(
        "postgresql-dap://postgresql/localhost/5433/testdb/postgres/session/session-1/routine/42/public.demo?unexpected=true",
      ),
    ).toBeUndefined();
  });

  it("preserves a client-owned scheme and authority without reinterpretation", () => {
    const source = "my-debugger://database-context/routine/42";
    expect(clientSourceUris({ 42: source }).get(42)).toBe(source);
  });

  it("keeps standalone source identities distinct across databases and sessions", () => {
    const base = {
      host: "localhost",
      port: 5433,
      database: "first",
      user: "postgres",
      sessionId: "session-1",
    };
    expect(standaloneSourceUri(42, base, "public.demo")).not.toBe(
      standaloneSourceUri(42, { ...base, database: "second" }, "public.demo"),
    );
    expect(standaloneSourceUri(42, base, "public.demo")).not.toBe(
      standaloneSourceUri(42, { ...base, sessionId: "session-2" }, "public.demo"),
    );
    const source = standaloneSourceUri(42, base, "public.demo");
    expect(standaloneSourceOid(source, { ...base, database: "second" })).toBeUndefined();
    expect(standaloneSourceOid(source, { ...base, sessionId: "session-2" })).toBeUndefined();
  });

  it("rejects relative client source paths", () => {
    expect(() => clientSourceUris({ 42: "sources/routine.sql" })).toThrow(
      /Invalid absolute client source URI/,
    );
  });

  it("rejects a canonical identity mapped to multiple deployment OIDs", () => {
    expect(() => clientSourceUris({ 42: SYMBOL, 84: SYMBOL })).toThrow(
      /mapped to more than one routine/,
    );
  });
});
