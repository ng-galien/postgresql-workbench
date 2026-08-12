import { describe, expect, it } from "vitest";
import { clientSourceUris } from "./sourceRegistry.js";

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

  it("accepts a missing client registry without inventing a source URI", () => {
    expect(clientSourceUris(undefined)).toEqual(new Map());
  });

  it("preserves a client-owned scheme and authority without reinterpretation", () => {
    const source = "my-debugger://database-context/routine/42";
    expect(clientSourceUris({ 42: source }).get(42)).toBe(source);
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
