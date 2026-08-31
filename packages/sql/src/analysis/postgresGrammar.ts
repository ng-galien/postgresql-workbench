import {
  GRAMMAR_ANONYMOUS_KINDS,
  PLPGSQL_GRAMMAR_KINDS,
  SQL_GRAMMAR_KINDS,
} from "./grammarKinds.js";
import type { SyntaxLanguage, SyntaxNode } from "./syntaxTree.js";

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

const SQL_STATEMENT_SCOPE_KINDS = verifiedGrammarKinds(
  SQL_GRAMMAR_KINDS,
  "SQL",
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CallStmt",
);

const PLPGSQL_BLOCK_SCOPE_KINDS = verifiedGrammarKinds(
  PLPGSQL_GRAMMAR_KINDS,
  "PL/pgSQL",
  PLPGSQL_BLOCK,
);

/** Whether the official SQL grammar node opens a Workbench query scope. */
export function isPostgresSqlStatementScopeKind(kind: string): boolean {
  return SQL_STATEMENT_SCOPE_KINDS.has(kind);
}

/** Whether the official PL/pgSQL grammar node opens a nested procedural block. */
export function isPlpgsqlBlockScopeKind(kind: string): boolean {
  return PLPGSQL_BLOCK_SCOPE_KINDS.has(kind);
}

const PLPGSQL_DECLARATION = verifiedGrammarKinds(
  PLPGSQL_GRAMMAR_KINDS,
  "PL/pgSQL",
  "decl_statement",
);
const PLPGSQL_DECLARATION_NAME = verifiedGrammarKinds(
  PLPGSQL_GRAMMAR_KINDS,
  "PL/pgSQL",
  "decl_varname",
);
const PLPGSQL_DECLARATION_TYPE = verifiedGrammarKinds(
  PLPGSQL_GRAMMAR_KINDS,
  "PL/pgSQL",
  "decl_datatype",
);
const PLPGSQL_CONSTANT = verifiedGrammarKinds(PLPGSQL_GRAMMAR_KINDS, "PL/pgSQL", "kw_constant");
const PLPGSQL_DOTTED_NAME = verifiedGrammarKinds(PLPGSQL_GRAMMAR_KINDS, "PL/pgSQL", "dotted_name");
const PLPGSQL_ANY_IDENTIFIER = verifiedGrammarKinds(
  PLPGSQL_GRAMMAR_KINDS,
  "PL/pgSQL",
  "any_identifier",
);
const SQL_ROUTINE_ARGUMENT = verifiedGrammarKinds(SQL_GRAMMAR_KINDS, "SQL", "func_arg");
const SQL_ROUTINE_ARGUMENT_NAME = verifiedGrammarKinds(SQL_GRAMMAR_KINDS, "SQL", "param_name");
const SQL_ROUTINE_DECLARATION = verifiedGrammarKinds(
  SQL_GRAMMAR_KINDS,
  "SQL",
  "CreateFunctionStmt",
);

export interface PlpgsqlVariableDeclarationSyntax {
  name: SyntaxNode;
  readonly: boolean;
  type?: SyntaxNode;
  typeForm?: "qualified" | "phrase";
}

/**
 * Reads one block variable declaration from the PL/pgSQL grammar. The reducer deliberately
 * receives nodes, not text: if the provider cannot expose this shape, there is no declaration.
 */
export function plpgsqlVariableDeclaration(
  node: SyntaxNode,
): PlpgsqlVariableDeclarationSyntax | undefined {
  if (!PLPGSQL_DECLARATION.has(node.kind)) return undefined;
  const name = node.children.find((child) => PLPGSQL_DECLARATION_NAME.has(child.kind));
  if (!name) return undefined;
  const type = node.children.find((child) => PLPGSQL_DECLARATION_TYPE.has(child.kind));
  const dottedType =
    type === undefined
      ? undefined
      : descendantMatching(type, (candidate) => PLPGSQL_DOTTED_NAME.has(candidate.kind));
  return {
    name,
    readonly: node.children.some((child) => PLPGSQL_CONSTANT.has(child.kind)),
    ...(type === undefined
      ? {}
      : {
          type,
          typeForm:
            (dottedType?.children.filter((child) => PLPGSQL_ANY_IDENTIFIER.has(child.kind))
              .length ?? 0) > 1
              ? "qualified"
              : "phrase",
        }),
  };
}

/** A named SQL routine argument, proven by its grammar parent rather than surrounding text. */
export function isSqlRoutineArgumentName(
  node: SyntaxNode,
  parent: SyntaxNode | undefined,
): boolean {
  return (
    SQL_ROUTINE_ARGUMENT_NAME.has(node.kind) &&
    parent !== undefined &&
    SQL_ROUTINE_ARGUMENT.has(parent.kind)
  );
}

/** The CREATE FUNCTION/PROCEDURE node that owns a routine argument, if there is one. */
export function sqlRoutineDeclarationOwner(
  ancestors: readonly SyntaxNode[],
): SyntaxNode | undefined {
  return [...ancestors].reverse().find((ancestor) => SQL_ROUTINE_DECLARATION.has(ancestor.kind));
}

function descendantMatching(
  node: SyntaxNode,
  predicate: (candidate: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = descendantMatching(child, predicate);
    if (found) return found;
  }
  return undefined;
}

/**
 * How an anonymous kind reads: what separates, or what computes. The kinds themselves are the
 * grammars' own, generated; only this split is a decision, and it is total — an anonymous kind
 * that is not named a separator is an operator, so a grammar that grows a new one cannot fall
 * through unpainted.
 */
const SEPARATORS: ReadonlySet<string> = new Set(["(", ")", ",", ";", ".", "..", ":", "[", "]"]);

export function anonymousKind(kind: string): "punctuation" | "operator" {
  return SEPARATORS.has(kind) ? "punctuation" : "operator";
}

/** Every anonymous kind the grammars can produce, for the split above to be held against. */
export const GRAMMAR_ANONYMOUS: readonly string[] = GRAMMAR_ANONYMOUS_KINDS;

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

/**
 * What a piece of a statement is, when it is not a name. A tuple rather than a union, because the
 * server's legend is built from it by position: a legend is read by number, and a list that is
 * spelled twice is a numbering that can silently split.
 */
export const SQL_LEXICAL_TOKEN_TYPES = [
  "keyword",
  "string",
  "number",
  "comment",
  "operator",
  "punctuation",
] as const;

export type SqlLexicalKind = (typeof SQL_LEXICAL_TOKEN_TYPES)[number];

/**
 * The kinds that are one lexical piece, drawn from both grammars: the literals, the dollar-quoted
 * bodies, the comments. Read rather than listed, because a list had already missed two spellings
 * of a string that nobody had thought of. A dollar-quoted body is one piece only until the grammar
 * injects a parse inside it — the reader descends into an injection, and only the delimiters stay
 * the literal's.
 */
export const SQL_LEXICAL_KINDS: ReadonlyMap<string, SqlLexicalKind> =
  lexicalKinds(SQL_GRAMMAR_KINDS);

export const PLPGSQL_LEXICAL_KINDS: ReadonlyMap<string, SqlLexicalKind> =
  lexicalKinds(PLPGSQL_GRAMMAR_KINDS);

/** Lexical classification always names the grammar that produced the node. */
export function postgresLexicalKind(
  language: SyntaxLanguage,
  kind: string,
): SqlLexicalKind | undefined {
  return (language === "sql" ? SQL_LEXICAL_KINDS : PLPGSQL_LEXICAL_KINDS).get(kind);
}

function lexicalKinds(kinds: readonly string[]): ReadonlyMap<string, SqlLexicalKind> {
  return new Map(
    kinds.flatMap((kind): [string, SqlLexicalKind][] => {
      if (kind === "comment") return [[kind, "comment"]];
      if (kind === "dollar_quoted_string") return [[kind, "string"]];
      if (!kind.endsWith("_literal")) return [];
      return [[kind, kind.includes("string") || kind.includes("bit") ? "string" : "number"]];
    }),
  );
}

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

function verifiedGrammarKinds(
  authority: readonly string[],
  language: string,
  ...selected: readonly string[]
): ReadonlySet<string> {
  for (const kind of selected) {
    if (!authority.includes(kind)) {
      throw new Error(`Unknown ${language} grammar scope kind: ${kind}`);
    }
  }
  return new Set(selected);
}
