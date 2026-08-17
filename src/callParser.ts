import {
  preferredSqlCallApplication,
  sqlFunctionNameParts,
  sqlRoutineBody,
  sqlRoutineBodyLiteral,
  sqlRoutineLanguage,
  sqlRoutineNameParts,
  sqlRoutineParameters,
} from "./analysis/sqlSyntax.js";
import {
  assertUsableSyntaxTree,
  decodeSqlLiteral,
  directSyntaxChild,
  findSyntaxNode,
  findSyntaxNodes,
  syntaxNodeText,
  syntaxTreeHasKind,
} from "./analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./analysis/syntaxTree.js";

export interface FunctionDefinition {
  schema: string | null;
  name: string;
  params: FunctionParam[];
  line: number;
  kind: "function" | "procedure";
  sourceSql?: string;
  body?: string;
}

export interface FunctionParam {
  name: string | null;
  type: string;
  mode: "in" | "out" | "inout" | "variadic" | "default";
}

export interface ParsedCall {
  schema: string | null;
  routine: string | null;
  args: string[];
  kind?: "function" | "procedure" | null;
}

/** Top-level statement kinds that may own a replayable debugger entry point. */
const DEBUG_ENTRY_STATEMENT_KINDS = new Set(["SelectStmt", "CallStmt", "DoStmt"]);

export interface ParsedCallSite {
  schema: string | null;
  routine: string;
  args: string[];
  sql: string;
  isLaunchable: boolean;
  line: number;
  kind: "call" | "select";
}

export async function parseCall(sql: string, parser: SyntaxParser): Promise<ParsedCall> {
  const syntax = await parseUsableSql(sql, parser);
  const statements = topLevelStatements(syntax);
  if (statements.length > 1) {
    throw new Error("A debug target must contain exactly one SQL statement");
  }
  const statement = statements[0];
  if (!statement) return emptyCall();
  const doStatement = findSyntaxNode(statement, "DoStmt");
  if (doStatement) {
    const call = await callInsideDo(sql, doStatement, parser);
    return call
      ? { ...extractCall(call.source, call.application), kind: "procedure" }
      : emptyCall();
  }
  const kind = findSyntaxNode(statement, "CallStmt")
    ? "procedure"
    : findSyntaxNode(statement, "SelectStmt")
      ? "function"
      : null;
  if (!kind) return emptyCall();
  const application = preferredSqlCallApplication(statement);
  return application ? { ...extractCall(sql, application), kind } : emptyCall();
}

export async function parseSqlFile(
  sql: string,
  parser: SyntaxParser,
): Promise<{ definitions: FunctionDefinition[]; calls: ParsedCallSite[] }> {
  try {
    return await parseSqlFileStrict(sql, parser);
  } catch {
    return { definitions: [], calls: [] };
  }
}

export async function parseSqlFileStrict(
  sql: string,
  parser: SyntaxParser,
): Promise<{ definitions: FunctionDefinition[]; calls: ParsedCallSite[] }> {
  const syntax = await parseUsableSql(sql, parser);
  return {
    definitions: extractDefinitions(sql, syntax),
    calls: await extractCalls(sql, syntax, parser),
  };
}

export async function parseSqlDefinitions(
  sql: string,
  parser: SyntaxParser,
): Promise<FunctionDefinition[]> {
  return (await parseSqlFile(sql, parser)).definitions;
}

export async function parseSqlCalls(sql: string, parser: SyntaxParser): Promise<ParsedCallSite[]> {
  return (await parseSqlFile(sql, parser)).calls;
}

async function parseUsableSql(source: string, parser: SyntaxParser): Promise<SyntaxTree> {
  const syntax = await parser.parse({ language: "sql", source, uri: "statements.sql" });
  assertUsableSyntaxTree(syntax, "SQL");
  return syntax;
}

function topLevelStatements(syntax: SyntaxTree): SyntaxNode[] {
  return syntax.root.children.filter((child) => child.kind === "toplevel_stmt");
}

/** Statement node owning a top-level statement (`SelectStmt`, `InsertStmt`, ...). */
function statementKindNode(statement: SyntaxNode): SyntaxNode | undefined {
  if (/Stmt$/u.test(statement.kind)) return statement;
  for (const child of statement.children) {
    const found = statementKindNode(child);
    if (found) return found;
  }
  return undefined;
}

function extractDefinitions(source: string, syntax: SyntaxTree): FunctionDefinition[] {
  const definitions: FunctionDefinition[] = [];
  for (const statement of topLevelStatements(syntax)) {
    const create = findSyntaxNode(statement, "CreateFunctionStmt");
    if (!create || sqlRoutineLanguage(source, create) !== "plpgsql") continue;
    const names = sqlRoutineNameParts(source, create);
    const name = names.at(-1);
    if (!name) continue;
    const isProcedure = findSyntaxNode(create, "kw_procedure") !== undefined;
    const bodyLiteral = sqlRoutineBodyLiteral(create);
    definitions.push({
      schema: names.length > 1 ? names.at(-2)! : null,
      name,
      params: extractParameters(source, create),
      line: statement.start.line,
      kind: isProcedure ? "procedure" : "function",
      sourceSql: syntaxNodeText(source, statement).trim(),
      ...(bodyLiteral ? { body: decodeSqlLiteral(syntaxNodeText(source, bodyLiteral)) } : {}),
    });
  }
  return definitions;
}

function extractParameters(source: string, create: SyntaxNode): FunctionParam[] {
  return sqlRoutineParameters(source, create).flatMap(({ name, type, mode }) =>
    mode === "out" || mode === "table" ? [] : [{ name, type, mode }],
  );
}

async function extractCalls(
  source: string,
  syntax: SyntaxTree,
  parser: SyntaxParser,
): Promise<ParsedCallSite[]> {
  const calls: ParsedCallSite[] = [];
  for (const statement of topLevelStatements(syntax)) {
    const entry = statementKindNode(statement);
    if (!entry || !DEBUG_ENTRY_STATEMENT_KINDS.has(entry.kind)) continue;
    const doStatement = entry.kind === "DoStmt" ? entry : undefined;
    if (doStatement) {
      const call = await callInsideDo(source, doStatement, parser);
      if (!call) continue;
      const parsed = extractCall(call.source, call.application);
      if (!parsed.routine) continue;
      calls.push({
        schema: parsed.schema,
        routine: parsed.routine,
        args: parsed.args,
        sql: syntaxNodeText(source, statement).trim(),
        isLaunchable: true,
        line: statement.start.line,
        kind: "call",
      });
      continue;
    }
    const callStatement = entry.kind === "CallStmt" ? entry : undefined;
    const application = preferredSqlCallApplication(entry);
    if (!application) continue;
    const parsed = extractCall(source, application);
    if (!parsed.routine) continue;
    calls.push({
      schema: parsed.schema,
      routine: parsed.routine,
      args: parsed.args,
      sql: syntaxNodeText(source, statement).trim(),
      isLaunchable: !containsExternalReference(application),
      line: statement.start.line,
      kind: callStatement ? "call" : "select",
    });
  }
  return calls;
}

async function callInsideDo(
  source: string,
  statement: SyntaxNode,
  parser: SyntaxParser,
): Promise<{ source: string; application: SyntaxNode } | undefined> {
  const body = sqlRoutineBody(source, statement);
  if (!body) return undefined;
  const syntax = await parser.parse({ language: "plpgsql", source: body, uri: "do-block.sql" });
  assertUsableSyntaxTree(syntax, "PL/pgSQL");
  const calls = findSyntaxNodes(syntax.root, "stmt_call");
  if (calls.length !== 1) return undefined;
  const expression = directSyntaxChild(calls[0], "sql_expression");
  if (!expression) return undefined;
  const callSource = `CALL ${syntaxNodeText(body, expression).trim()}`;
  const callSyntax = await parseUsableSql(callSource, parser);
  const callStatement = topLevelStatements(callSyntax)[0];
  const application = callStatement ? preferredSqlCallApplication(callStatement) : undefined;
  return application ? { source: callSource, application } : undefined;
}

function extractCall(source: string, application: SyntaxNode): ParsedCall {
  const names = sqlFunctionNameParts(source, application);
  if (names.length === 0) return emptyCall();
  const routine = names.at(-1) ?? null;
  const argsNode = directSyntaxChild(application, "func_arg_list");
  const args = argsNode
    ? topLevelArguments(argsNode).map((argument) => syntaxNodeText(source, argument).trim())
    : [];
  return {
    schema: names.length > 1 ? names.at(-2)! : null,
    routine,
    args,
  };
}

function topLevelArguments(list: SyntaxNode, result: SyntaxNode[] = []): SyntaxNode[] {
  for (const child of list.children) {
    if (child.kind === "func_arg_expr") result.push(child);
    else if (child.kind === "func_arg_list") topLevelArguments(child, result);
  }
  return result;
}

function containsExternalReference(application: SyntaxNode): boolean {
  const args = directSyntaxChild(application, "func_arg_list");
  if (!args) return false;
  return syntaxTreeHasKind(args, new Set(["ColumnRef", "columnref", "ParamRef", "param_ref"]));
}

function emptyCall(): ParsedCall {
  return { schema: null, routine: null, args: [], kind: null };
}
