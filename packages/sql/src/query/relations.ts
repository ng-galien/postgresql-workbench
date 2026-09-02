import {
  type PostgresColumnFact,
  type PostgresDocumentSyntaxFacts,
  type PostgresRelationFact,
  type PostgresRoutineFact,
  postgresDocumentSyntaxFactsFromTree,
} from "../analysis/documentFacts.js";
import type { SyntaxNode, SyntaxParser } from "../analysis/syntaxTree.js";
import { byteToUtf16Offsets } from "../analysis/textOffsets.js";
import type { SqlAuthoringObject } from "../snapshot.js";
import { canonicalSqlIdentifier, unquoteSqlIdentifier } from "../text/identifiers.js";
import type { SqlQueryAnalysis } from "./analysis.js";

export interface DocumentRelationsOptions {
  uri: string;
  maxDepth: number;
  maxNodes: number;
  /** Offset being typed: a placeholder is inserted there so an unfinished statement parses. */
  caret?: number;
}

/**
 * Every relation a document names, including inside the PL/pgSQL body of a `DO` block — which the
 * SQL grammar sees as a dollar-quoted string, so it is parsed on its own. The single way any
 * feature learns what relations a document uses.
 */
/** What the caret is naming: a relation (after FROM, JOIN, INTO, USING) or an expression. */
export type SqlCaretRole = "relation" | "expression";

export interface DocumentMentions {
  source: string;
  relations: SqlRelationMention[];
  columns: SqlColumnMention[];
  routines: SqlRoutineMention[];
  /** The single parser-proven document from which every compatibility projection derives. */
  facts: PostgresDocumentSyntaxFacts;
  /** Set when a caret was given: what the placeholder stands in for, read from the tree. */
  caretRole?: SqlCaretRole;
}

/** Role of the node the placeholder landed in, from its ancestors — never from the text before it. */
function caretRoleOf(
  root: SyntaxNode,
  text: string,
  charOffset: (byte: number) => number,
): SqlCaretRole | undefined {
  const placeholder = text.indexOf(CARET_PLACEHOLDER);
  if (placeholder < 0) return undefined;
  let role: SqlCaretRole | undefined;
  const visit = (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => {
    const start = charOffset(node.byteRange[0]);
    const end = charOffset(node.byteRange[1]);
    if (start > placeholder || end < placeholder + CARET_PLACEHOLDER.length) return;
    if (node.children.length === 0) {
      const path = [...ancestors, node];
      role = path.some(
        (candidate) =>
          candidate.kind === "relation_expr" ||
          candidate.kind === "relation_expr_opt_alias" ||
          candidate.kind === "insert_target",
      )
        ? "relation"
        : "expression";
      return;
    }
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return role;
}

export async function documentRelations(
  parser: SyntaxParser,
  source: string,
  options: DocumentRelationsOptions,
): Promise<DocumentMentions> {
  const { caret, uri, maxDepth, maxNodes } = options;
  const parsed =
    caret === undefined
      ? source
      : `${source.slice(0, caret)}${CARET_PLACEHOLDER}${source.slice(caret)}`;
  const budget = { uri, maxDepth, maxNodes, namedOnly: false } as const;
  const tree = await parser.parse({ language: "sql", source: parsed, ...budget });
  const facts = postgresDocumentSyntaxFactsFromTree(parsed, tree);
  if (facts.shape.truncated) {
    return { source: parsed, relations: [], columns: [], routines: [], facts };
  }
  const offsets = byteToUtf16Offsets(parsed);
  const caretRole = caret === undefined ? undefined : caretRoleOf(tree.root, parsed, offsets);
  return {
    source: parsed,
    ...documentMentionsOfFacts(facts, parsed),
    facts,
    ...(caretRole === undefined ? {} : { caretRole }),
  };
}

/** The mention projections of a facts document, for a consumer that already holds the facts. */
export function documentMentionsOfFacts(
  facts: PostgresDocumentSyntaxFacts,
  source: string,
): Pick<DocumentMentions, "relations" | "columns" | "routines"> {
  return {
    relations: facts.names
      .filter((fact): fact is PostgresRelationFact => fact.role === "relation")
      .map((fact) => relationMention(fact, source)),
    columns: facts.names
      .filter((fact): fact is PostgresColumnFact => fact.role === "column")
      .map(columnMention),
    routines: facts.names
      .filter((fact): fact is PostgresRoutineFact => fact.role === "routine")
      .map(routineMention),
  };
}

function relationMention(fact: PostgresRelationFact, source: string): SqlRelationMention {
  const name = fact.parts.at(-1);
  if (!name) throw new Error("A relation fact requires a name");
  const schema = fact.parts.at(-2);
  return {
    ...(schema ? { schema: unquoteSqlIdentifier(schema.written) } : {}),
    name: unquoteSqlIdentifier(name.written),
    catalogName: name.canonical,
    ...(schema ? { catalogSchema: schema.canonical } : {}),
    ...(fact.alias ? { alias: unquoteSqlIdentifier(fact.alias.written) } : {}),
    reference: fact.alias?.written ?? name.written,
    qualifiedText: source.slice(fact.range.start, fact.range.end),
    nameRange: fact.range,
    ...(fact.alias ? { aliasRange: fact.alias.range } : {}),
  };
}

function columnMention(fact: PostgresColumnFact): SqlColumnMention {
  const name = fact.parts.at(-1);
  if (!name) throw new Error("A column fact requires a name");
  const qualifier = fact.parts.at(-2);
  return {
    ...(qualifier ? { qualifier: unquoteSqlIdentifier(qualifier.written) } : {}),
    name: unquoteSqlIdentifier(name.written),
    nameRange: name.range,
  };
}

function routineMention(fact: PostgresRoutineFact): SqlRoutineMention {
  const name = fact.parts.at(-1);
  if (!name) throw new Error("A routine fact requires a name");
  const schema = fact.parts.at(-2);
  return {
    ...(schema ? { schema: unquoteSqlIdentifier(schema.written) } : {}),
    name: unquoteSqlIdentifier(name.written),
    nameRange: name.range,
  };
}

/** Identifier inserted where the user is typing, so an unfinished statement still parses. */
export const CARET_PLACEHOLDER = "sql_authoring_caret";

/** A relation named by a statement, wherever it appears: FROM, JOIN, USING, UPDATE, INSERT INTO. */
export interface SqlRelationMention {
  schema?: string;
  name: string;
  /**
   * The name and schema as PostgreSQL stores them: what was quoted keeps its case, what was not is
   * folded. Computed from the text as written, so it must never be canonicalised a second time.
   */
  catalogName: string;
  catalogSchema?: string;
  alias?: string;
  /** How columns qualify it, as written: its alias, or its name. */
  reference: string;
  /** The qualified name as written, and its character range. */
  qualifiedText: string;
  nameRange: { start: number; end: number };
  /** Character range of the alias, when one is written. */
  aliasRange?: { start: number; end: number };
}

/** A column reference written in a statement, with its optional qualifier. */
export interface SqlColumnMention {
  qualifier?: string;
  name: string;
  nameRange: { start: number; end: number };
}

/** A routine called in a statement. */
export interface SqlRoutineMention {
  schema?: string;
  name: string;
  nameRange: { start: number; end: number };
}

/** An indexed relation of the query, with the name expressions must use to qualify its columns. */
export interface TableReference {
  correlationName: string;
  nullExtended: boolean;
  object: SqlAuthoringObject;
  reference: string;
}

/**
 * The relations of a query, resolved against the Workbench Index from the syntax tree. A relation
 * the index does not know, or knows twice, is left out: composing on it could not be checked.
 */
export function relationsFromAnalysis(
  analysis: SqlQueryAnalysis,
  objects: readonly SqlAuthoringObject[],
): TableReference[] {
  const references: TableReference[] = [];
  for (const relation of analysis.relations) {
    // A RIGHT or FULL join makes every relation already collected nullable.
    if (relation.join && /\b(?:RIGHT|FULL)\b/u.test(relation.join.type)) {
      for (const reference of references) reference.nullExtended = true;
    }
    if (relation.catalogSchema === undefined) continue;
    const schema = relation.catalogSchema;
    const name = relation.catalogName;
    const candidates = objects.filter(
      (candidate) =>
        candidate.schema === schema &&
        candidate.name === name &&
        (candidate.kind === "table" || candidate.kind === "view"),
    );
    const object = candidates.length === 1 ? candidates[0] : undefined;
    if (!object) continue;
    const reference = relation.reference;
    references.push({
      correlationName: canonicalSqlIdentifier(reference),
      nullExtended: relation.join !== undefined && /\b(?:LEFT|FULL)\b/u.test(relation.join.type),
      object,
      reference,
    });
  }
  return references;
}
