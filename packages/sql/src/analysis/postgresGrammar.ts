import { PLPGSQL_GRAMMAR_KINDS, SQL_GRAMMAR_KINDS } from "./grammarKinds.js";
import type { SyntaxNode } from "./syntaxTree.js";

/**
 * What the grammar names, asked of the grammar.
 *
 * Every layer that reads a parse needs some of this vocabulary, and each one had written down the
 * part it needed: the debugger listed the statements a reader can step onto, coverage listed the
 * ones it labels and, separately, the ones that loop, and a third list said which nodes are
 * literals. Four lists of one grammar, kept by hand, in two packages.
 *
 * They were all wrong, and nothing could say so — a list written from an idea of a grammar reads
 * exactly like one read from it. The grammar produces twenty-three statements: the debugger named
 * two it does not produce and missed four, coverage missed seven, and the literal list left `E'…'`
 * and `X'…'` uncoloured. That is not carelessness; the lists had no author to be checked against.
 *
 * They do now. Tree-sitter generates the complete list of node kinds beside every grammar it
 * builds, and those grammars are themselves generated from PostgreSQL's `gram.y` and `kwlist.h` —
 * so the author is PostgreSQL. `grammarKinds.ts` is that list, taken from the two grammars Code
 * Moniker actually runs, and everything below is derived from it. What is left to decide is small,
 * and it is decided here rather than once per layer.
 */

const STATEMENT_PREFIX = "stmt_";

/** How this grammar spells a word PostgreSQL reserves — every one of the several hundred. */
export const SQL_KEYWORD_PREFIX = "kw_";

/**
 * Every statement a PL/pgSQL body is made of. Read from the grammar, so `COMMIT`, `MOVE`,
 * `ROLLBACK` and `NULL` are here — the four that every hand-written list had forgotten.
 */
export const PLPGSQL_STATEMENT_KINDS: ReadonlySet<string> = new Set(
  PLPGSQL_GRAMMAR_KINDS.filter((kind) => kind.startsWith(STATEMENT_PREFIX)),
);

/** The node a `proc_stmt` wraps when it opens another body instead of holding a statement. */
export const PLPGSQL_BLOCK = "pl_block";

/**
 * The word to show for a statement: the grammar's own, without the prefix it spells it with. Only
 * where that word carries something a reader has no use for is another one chosen.
 */
const SHOWN_AS: Readonly<Record<string, string>> = { stmt_foreach_a: "foreach" };

/**
 * Forms of one statement, told apart by a keyword hanging under it rather than by a kind of their
 * own. To this grammar `RETURN NEXT` is a `RETURN`, and `CONTINUE` is an `EXIT`.
 */
const FORMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  stmt_return: { kw_next: "return_next", kw_query: "return_query" },
  stmt_exit: { kw_continue: "continue" },
};

/**
 * Where a reserved word stands for a name rather than for itself. PostgreSQL lets most of its words
 * be used as identifiers and the parser still lexes them as the keywords they are, so a layer asks
 * where the word sits. This is the one list here that is a decision rather than a reading, which is
 * why every entry is kept only if the grammar has it.
 */
export const SQL_NAME_POSITIONS: ReadonlySet<string> = new Set(
  ["ColId", "ColLabel", "attr_name", "qualified_name", "name", "type_function_name"].filter(
    (kind) => SQL_GRAMMAR_KINDS.includes(kind),
  ),
);

/** What a piece of a statement is, when it is not a name. */
export type SqlLexicalKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "punctuation";

/**
 * The kinds whose whole span is one piece, whatever they contain: the grammar's literals, its
 * dollar-quoted bodies, and its comments. Read rather than listed, because a list had already
 * missed two spellings of a string that nobody had thought of.
 */
export const SQL_LEXICAL_KINDS: ReadonlyMap<string, SqlLexicalKind> = new Map(
  SQL_GRAMMAR_KINDS.flatMap((kind): [string, SqlLexicalKind][] => {
    if (kind === "comment") return [[kind, "comment"]];
    if (kind === "dollar_quoted_string") return [[kind, "string"]];
    if (!kind.endsWith("_literal")) return [];
    return [[kind, kind.includes("string") || kind.includes("bit") ? "string" : "number"]];
  }),
);

/** What a `proc_stmt` holds. A layer walking a body meets one or the other, never both. */
export type PlpgsqlProcedureStep =
  | { held: "statement"; node: SyntaxNode }
  | { held: "block"; node: SyntaxNode };

/**
 * What this step of a body is. Reading it here rather than in each layer is what keeps a nested
 * `BEGIN … END` from being skipped: it is the one step the grammar does not spell `stmt_`.
 */
export function plpgsqlStep(procedureStatement: SyntaxNode): PlpgsqlProcedureStep | undefined {
  for (const child of procedureStatement.children) {
    if (PLPGSQL_STATEMENT_KINDS.has(child.kind)) return { held: "statement", node: child };
    if (child.kind === PLPGSQL_BLOCK) return { held: "block", node: child };
  }
  return undefined;
}

/**
 * What this statement is called, in the form it was written: the statement's own word, or the form
 * a keyword under it puts it in.
 */
export function plpgsqlStatementName(node: SyntaxNode): string | undefined {
  if (!PLPGSQL_STATEMENT_KINDS.has(node.kind)) return undefined;
  const forms = FORMS[node.kind];
  const taken = forms && node.children.find((child) => forms[child.kind] !== undefined);
  if (taken && forms) return forms[taken.kind];
  return SHOWN_AS[node.kind] ?? node.kind.slice(STATEMENT_PREFIX.length);
}
