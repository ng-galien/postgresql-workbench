import { describe, expect, it } from "vitest";
import { canonicalSourceUris, standaloneSourceOid, standaloneSourceUri } from "./sourceRegistry.js";

const SYMBOL =
  "code+moniker://./srcset:test/lang:sql/dir:public/dir:routine/module:demo%28integer%29/schema:public/function:demo%28integer%29";
const DOCUMENT = `code+moniker://postgresql/testdb/public/function/demo(integer)?${encodeURIComponent(
  JSON.stringify({ identity: SYMBOL, label: "testdb/public/function/demo(integer)" }),
)}`;

describe("DAP Code Moniker source registry", () => {
  it("preserves the exact caller-supplied canonical URI", () => {
    expect(canonicalSourceUris({ 42: SYMBOL }).get(42)).toBe(SYMBOL);
  });

  it("preserves a human document URI while validating its canonical identity", () => {
    expect(canonicalSourceUris({ 42: DOCUMENT }).get(42)).toBe(DOCUMENT);
  });

  it("accepts a missing indexed registry for a standalone DAP client", () => {
    expect(canonicalSourceUris(undefined)).toEqual(new Map());
    expect(standaloneSourceUri(42)).toBe("postgresql-dap://routine/42");
    expect(standaloneSourceOid("postgresql-dap://routine/42")).toBe(42);
  });

  it("rejects non-Code-Moniker identities when an indexed registry is supplied", () => {
    expect(() => canonicalSourceUris({ 42: "postgresql://server/db/routine.sql" })).toThrow(
      /Invalid canonical Code Moniker/,
    );
  });

  it("rejects a canonical identity mapped to multiple deployment OIDs", () => {
    expect(() => canonicalSourceUris({ 42: SYMBOL, 84: DOCUMENT })).toThrow(
      /mapped to more than one routine/,
    );
  });
});
