import { plpgsqlStep } from "./analysis/postgresGrammar.js";
import { sqlFunctionApplications } from "./analysis/sqlSyntax.js";
import {
  assertUsableSyntaxTree,
  canonicalSqlTypeName,
  directSyntaxChild,
  directSyntaxChildren,
  findSyntaxNode,
  findSyntaxNodes,
  syntaxNodeText,
} from "./analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./analysis/syntaxTree.js";

export interface PlVariable {
  name: string;
  type: string;
  line: number;
  isConst: boolean;
}

export interface PlFunctionCall {
  name: string;
  line: number;
}

export interface PlRecordField {
  name: string;
  /** PostgreSQL type inferred from an explicit SQL cast in the record-producing query. */
  type: string;
}

export interface ExceptionHandlerInfo {
  /** Body-relative line where the EXCEPTION handler action starts. */
  startLine: number;
  /** Condition names such as `others`, `no_data_found`, or `division_by_zero`. */
  conditions: string[];
}

export interface PlSourceAnalysis {
  variables: PlVariable[];
  functionCalls: PlFunctionCall[];
  /** Static field hints for anonymous records populated by SELECT INTO / FOR SELECT. */
  recordFields: Map<string, PlRecordField[]>;
  variablesByLine: Map<number, string[]>;
  steppableLines: Set<number>;
  exceptionHandlers: ExceptionHandlerInfo[];
}

interface SqlReference {
  source: string;
  line: number;
  mode: "expression" | "statement";
  collectCalls: boolean;
  recordVariable?: string;
}

interface ParsedSqlReference {
  calls: PlFunctionCall[];
  recordVariable?: string;
  recordFields: PlRecordField[];
}

/**
 * Analyze one authoritative `pg_proc.prosrc` PL/pgSQL body through Code Moniker syntax trees.
 * SQL expressions are reparsed stateless only for debugger metadata that requires SQL structure.
 */
export async function analyzeFunction(
  source: string,
  parser: SyntaxParser,
): Promise<PlSourceAnalysis> {
  const syntax = await parser.parse({
    language: "plpgsql",
    source,
    uri: "debugger.plpgsql",
  });
  assertUsableSyntaxTree(syntax, "PL/pgSQL");
  const block = findSyntaxNode(syntax.root, "pl_block");
  if (!block) {
    throw new Error("The source does not contain a PL/pgSQL block");
  }

  const variables = extractVariables(source, block);
  const variableNames = variables.map((variable) => variable.name);
  const variablesByLine = new Map<number, string[]>();
  const steppableLines = new Set<number>();
  const exceptionHandlers = extractExceptionHandlers(source, block);
  const sqlReferences: SqlReference[] = [];

  for (const wrapper of findSyntaxNodes(block, "proc_stmt")) {
    const step = plpgsqlStep(wrapper);
    if (step?.held !== "statement") continue;
    // Every statement of a body is one PostgreSQL stops on; the grammar says which nodes are one.
    steppableLines.add(step.node.start.line);
    collectStatementMetadata(source, step.node, variableNames, variablesByLine, sqlReferences);
  }
  for (const clause of findSyntaxNodes(block, "elsif_clause")) {
    steppableLines.add(clause.start.line);
  }

  const parsedReferences = await Promise.all(
    sqlReferences.map((reference) => parseSqlReference(reference, parser)),
  );
  const functionCalls = parsedReferences.flatMap((reference) => reference.calls);
  const recordFields = mergeRecordFields(parsedReferences);

  return {
    variables,
    functionCalls,
    recordFields,
    variablesByLine,
    steppableLines,
    exceptionHandlers,
  };
}

function extractVariables(source: string, block: SyntaxNode): PlVariable[] {
  const variables: PlVariable[] = [];
  for (const declaration of findSyntaxNodes(block, "decl_statement")) {
    const nameNode = findSyntaxNode(declaration, "decl_varname");
    const typeNode = findSyntaxNode(declaration, "decl_datatype");
    if (!nameNode || !typeNode) continue;
    const name = syntaxNodeText(source, nameNode).trim();
    const type = syntaxNodeText(source, typeNode).trim();
    if (!name || !type) continue;
    variables.push({
      name,
      type,
      line: declaration.start.line,
      isConst: findSyntaxNode(declaration, "kw_constant") !== undefined,
    });
  }
  return variables;
}

function collectStatementMetadata(
  source: string,
  statement: SyntaxNode,
  variableNames: readonly string[],
  variablesByLine: Map<number, string[]>,
  sqlReferences: SqlReference[],
): void {
  const expressions = directSyntaxChildren(statement, "sql_expression");
  if (statement.kind === "stmt_assign") {
    const target = expressions[0];
    const value = expressions[1];
    if (target) {
      const variable = assignedVariable(syntaxNodeText(source, target), variableNames);
      if (variable) addVarToLine(variablesByLine, statement.start.line, variable);
    }
    if (value) {
      sqlReferences.push(expressionReference(source, value, statement.start.line));
    }
    return;
  }
  if (statement.kind === "stmt_perform" || statement.kind === "stmt_return") {
    const expression = expressions[0];
    if (expression) {
      sqlReferences.push(expressionReference(source, expression, statement.start.line));
    }
    return;
  }
  if (statement.kind === "stmt_execsql") {
    const expression = expressions[0];
    if (expression) {
      sqlReferences.push({
        source: syntaxNodeText(source, expression),
        line: statement.start.line,
        mode: "statement",
        collectCalls: true,
      });
    }
    return;
  }
  if (statement.kind === "stmt_for") {
    const variableNode = findSyntaxNode(statement, "for_variable");
    const queryNode = findSyntaxNode(statement, "for_query");
    const queryExpression = queryNode ? findSyntaxNode(queryNode, "sql_expression") : undefined;
    if (variableNode && queryExpression) {
      sqlReferences.push({
        source: syntaxNodeText(source, queryExpression),
        line: statement.start.line,
        mode: "statement",
        collectCalls: false,
        recordVariable: syntaxNodeText(source, variableNode).trim(),
      });
    }
  }
}

function expressionReference(source: string, node: SyntaxNode, line: number): SqlReference {
  return {
    source: syntaxNodeText(source, node),
    line,
    mode: "expression",
    collectCalls: true,
  };
}

async function parseSqlReference(
  reference: SqlReference,
  parser: SyntaxParser,
): Promise<ParsedSqlReference> {
  const sql = reference.mode === "expression" ? `SELECT ${reference.source}` : reference.source;
  try {
    const syntax = await parser.parse({ language: "sql", source: sql, uri: "debugger.sql" });
    if (syntax.hasError || syntax.truncated) {
      return { calls: [], recordFields: [] };
    }
    const calls = reference.collectCalls ? extractFunctionCalls(sql, syntax, reference.line) : [];
    const recordVariable = reference.recordVariable ?? extractIntoVariable(sql, syntax);
    const recordFields = recordVariable ? extractRecordFields(sql, syntax) : [];
    return { calls, recordVariable, recordFields };
  } catch {
    return { calls: [], recordFields: [] };
  }
}

function extractFunctionCalls(source: string, syntax: SyntaxTree, line: number): PlFunctionCall[] {
  const calls: PlFunctionCall[] = [];
  for (const { nameParts } of sqlFunctionApplications(source, syntax.root)) {
    const name = nameParts.join(".");
    if (name) calls.push({ name, line });
  }
  return calls;
}

function extractIntoVariable(source: string, syntax: SyntaxTree): string | undefined {
  const into = findSyntaxNode(syntax.root, "into_clause");
  const target = into ? findSyntaxNode(into, "qualified_name") : undefined;
  const value = target ? syntaxNodeText(source, target).trim() : "";
  return value || undefined;
}

function extractRecordFields(source: string, syntax: SyntaxTree): PlRecordField[] {
  const fields: PlRecordField[] = [];
  for (const target of findSyntaxNodes(syntax.root, "target_el")) {
    const alias = findSyntaxNode(target, "ColLabel");
    const type = explicitTargetType(source, target);
    if (!alias || !type) continue;
    const name = syntaxNodeText(source, alias).trim();
    if (name) fields.push({ name, type });
  }
  return fields;
}

function explicitTargetType(source: string, target: SyntaxNode): string | undefined {
  const type = findSyntaxNode(target, "Typename");
  if (type) {
    const base = findSyntaxNode(type, "SimpleTypename") ?? type;
    const dimensions = findSyntaxNodes(type, "opt_array_bounds").reduce(
      (count, bounds) => count + findSyntaxNodes(bounds, "[").length,
      0,
    );
    return `${canonicalSqlTypeName(syntaxNodeText(source, base))}${"[]".repeat(dimensions)}`;
  }
  for (const constant of findSyntaxNodes(target, "AexprConst")) {
    const name = findSyntaxNode(constant, "func_name");
    const literal = findSyntaxNode(constant, "Sconst");
    if (!name || !literal) continue;
    const candidate = canonicalSqlTypeName(syntaxNodeText(source, name)).toLowerCase();
    if (TYPED_LITERAL_TYPES.has(candidate)) return candidate;
  }
  return undefined;
}

const TYPED_LITERAL_TYPES = new Set([
  "date",
  "interval",
  "time",
  "timestamp",
  "timetz",
  "timestamptz",
]);

function mergeRecordFields(
  references: readonly ParsedSqlReference[],
): Map<string, PlRecordField[]> {
  const result = new Map<string, PlRecordField[]>();
  const ambiguous = new Set<string>();
  for (const reference of references) {
    const variable = reference.recordVariable;
    if (!variable || reference.recordFields.length === 0 || ambiguous.has(variable)) continue;
    const existing = result.get(variable);
    if (!existing) {
      result.set(variable, reference.recordFields);
      continue;
    }
    if (!sameRecordShape(existing, reference.recordFields)) {
      result.delete(variable);
      ambiguous.add(variable);
    }
  }
  return result;
}

function sameRecordShape(left: readonly PlRecordField[], right: readonly PlRecordField[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) => field.name === right[index]?.name && field.type === right[index]?.type,
    )
  );
}

function extractExceptionHandlers(source: string, block: SyntaxNode): ExceptionHandlerInfo[] {
  const handlers: ExceptionHandlerInfo[] = [];
  for (const exception of findSyntaxNodes(block, "proc_exception")) {
    const section = directSyntaxChild(exception, "proc_sect");
    const firstStatement = section ? findSyntaxNode(section, "proc_stmt") : undefined;
    const statement = firstStatement?.children.find((child) => child.kind.startsWith("stmt_"));
    if (!statement) continue;
    const conditions = findSyntaxNodes(exception, "proc_condition")
      .map((condition) => syntaxNodeText(source, condition).trim())
      .filter(Boolean);
    handlers.push({ startLine: statement.start.line, conditions });
  }
  return handlers;
}

function assignedVariable(target: string, variableNames: readonly string[]): string | undefined {
  const trimmed = target.trim();
  for (const name of variableNames) {
    if (trimmed === name) return name;
    if (!trimmed.startsWith(name)) continue;
    const remainder = trimmed.slice(name.length).trimStart();
    if (remainder.startsWith(".")) return name;
  }
  return undefined;
}

function addVarToLine(map: Map<number, string[]>, line: number, variable: string): void {
  const existing = map.get(line);
  if (!existing) {
    map.set(line, [variable]);
  } else if (!existing.includes(variable)) {
    existing.push(variable);
  }
}
