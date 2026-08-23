import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CODE_MONIKER_TARGETS, hostCodeMonikerTarget } from "../extension/code-moniker-target.mjs";

/**
 * The boundary document in .code-moniker.toml is what an agent reads first to learn the
 * architecture. It names rules and symbols, and neither the TOML nor the linter checks that they
 * exist — so the packages move left it naming nineteen modules that had been gone for weeks.
 * These tests are that missing check: a document that lies costs more than no document.
 */

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const RULES_FILE = resolve(REPOSITORY_ROOT, ".code-moniker.toml");
const SYMBOL_PATTERN = /^ts:(.+?)\.(class|interface|function|type|const):(\w+)$/u;

const document = parse(readFileSync(RULES_FILE, "utf8"));
const view = document.views?.[0];
const sections = [...(view?.boundaries ?? []), ...(view?.gotchas ?? [])];

const namedRules = [
  ...new Set(
    sections.flatMap((section) => [...(section.rules ?? []), ...(section.forbid_rules ?? [])]),
  ),
].sort();
const namedSymbols = [...new Set(sections.flatMap((section) => section.symbols ?? []))].sort();

describe("the boundary document", () => {
  it("names at least one boundary and one rule", () => {
    expect(view?.boundaries?.length ?? 0).toBeGreaterThan(0);
    expect(namedRules.length).toBeGreaterThan(0);
    expect(namedSymbols.length).toBeGreaterThan(0);
  });

  it.each(namedRules)("names %s, a rule the workspace compiles", (rule) => {
    // The compiled set is what `check` actually runs, fragments included.
    expect(compiledRules()).toContain(rule);
  });

  it.each(namedSymbols)("names %s, a declaration that exists", (symbol) => {
    const match = SYMBOL_PATTERN.exec(symbol);
    expect(match, `${symbol} is not a compact TypeScript moniker`).not.toBeNull();
    const [, modulePath, kind, name] = match;
    const file = resolve(REPOSITORY_ROOT, `${modulePath}.ts`);
    expect(existsSync(file), `${file} does not exist`).toBe(true);
    expect(
      new RegExp(String.raw`\b${kind} ${name}\b`, "u").test(readFileSync(file, "utf8")),
      `${file} declares no ${kind} named ${name}`,
    ).toBe(true);
  });
});

let compiled;
function compiledRules() {
  // The binary is a per-platform package, resolved the way the packaging scripts resolve it.
  const { packageName } = CODE_MONIKER_TARGETS[hostCodeMonikerTarget()];
  compiled ??= execFileSync(
    resolve(REPOSITORY_ROOT, "node_modules", packageName, "bin", "code-moniker"),
    ["rules", "show"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return compiled;
}
