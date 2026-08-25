import { describe, expect, it } from "vitest";
import type { ParsedRoutine, RoutineVariable } from "./documentAnalysis.js";
import { plpgsqlSemanticTokens } from "./semanticTokens.js";

const TYPES = ["variable", "parameter", "type", "function"];
const DECLARATION = 1;
const READONLY = 2;

const variable = (over: Partial<RoutineVariable> = {}): RoutineVariable => ({
  name: "total",
  isParam: false,
  isConst: false,
  typeName: "numeric",
  declareLine: 1,
  ...over,
});

/** The source, with the routine spanning the lines given. */
function routine(source: string, variables: RoutineVariable[]): ParsedRoutine {
  const lines = source.split("\n");
  return {
    statementStartLine: 0,
    bodyStartLine: 0,
    bodyEndLine: lines.length - 1,
    variables,
  };
}

/** What was marked, said the way a reader of the test can check it. */
function marked(source: string, variables: RoutineVariable[]) {
  const lines = source.split("\n");
  return plpgsqlSemanticTokens(source, [routine(source, variables)]).map((token) => ({
    text: lines[token.line]?.slice(token.character, token.character + token.length),
    type: TYPES[token.tokenType],
    modifiers: token.tokenModifiers,
  }));
}

describe("what a PL/pgSQL body's own names are", () => {
  it("marks a variable once where it is declared, and once at each use", () => {
    const source = ["  total numeric;", "  total := 1;", "  RETURN total;"].join("\n");
    expect(marked(source, [variable({ declareLine: 1 })])).toEqual([
      { text: "total", type: "variable", modifiers: DECLARATION },
      { text: "numeric", type: "type", modifiers: 0 },
      { text: "total", type: "variable", modifiers: 0 },
      { text: "total", type: "variable", modifiers: 0 },
    ]);
  });

  it("tells a parameter from a variable, and gives it no declaration in the body", () => {
    const source = "  RETURN order_id;";
    expect(marked(source, [variable({ name: "order_id", isParam: true })])).toEqual([
      { text: "order_id", type: "parameter", modifiers: 0 },
    ]);
  });

  it("says a constant may not be written to again", () => {
    const source = "  rate CONSTANT numeric := 0.2;";
    const [declaration] = marked(source, [variable({ name: "rate", isConst: true })]);
    expect(declaration).toEqual({
      text: "rate",
      type: "variable",
      modifiers: DECLARATION | READONLY,
    });
  });

  it("marks a qualified type by the part that stands on the line, not past it", () => {
    const source = "  status shop.order_status;";
    expect(marked(source, [variable({ name: "status", typeName: "shop.order_status" })])).toEqual([
      { text: "status", type: "variable", modifiers: DECLARATION },
      { text: "order_status", type: "type", modifiers: 0 },
    ]);
  });

  it("leaves a line that is wholly a comment alone: a name written in prose is prose", () => {
    const source = ["  total numeric;", "  -- total is the sum", "  RETURN total;"].join("\n");
    const names = marked(source, [variable({ declareLine: 1 })]).filter(
      (token) => token.type === "variable",
    );
    expect(names).toHaveLength(2);
  });

  it("marks a name only where it stands alone, never inside a longer one", () => {
    const source = "  RETURN subtotal + total_x + total;";
    const names = marked(source, [variable({ declareLine: 0 })]);
    expect(names).toEqual([{ text: "total", type: "variable", modifiers: 0 }]);
  });

  it("answers in the order a reader reads, so nothing has to sort it afterwards", () => {
    const source = ["  b integer;", "  a integer;", "  a := b;"].join("\n");
    const tokens = plpgsqlSemanticTokens(source, [
      routine(source, [
        variable({ name: "b", typeName: "integer", declareLine: 1 }),
        variable({ name: "a", typeName: "integer", declareLine: 2 }),
      ]),
    ]);
    const places = tokens.map((token) => [token.line, token.character]);
    expect(places).toEqual(
      [...places].sort((one, other) => one[0]! - other[0]! || one[1]! - other[1]!),
    );
  });

  it("says nothing about a routine that declares nothing", () => {
    expect(plpgsqlSemanticTokens("  RETURN 1;", [routine("  RETURN 1;", [])])).toEqual([]);
  });
});
