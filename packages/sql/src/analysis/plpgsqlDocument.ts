import { analyzeFunction } from "../functionSource.js";
import { sqlRoutineBodyLiteral, sqlRoutineLanguage, sqlRoutineParameters } from "./sqlSyntax.js";
import { decodeSqlLiteral, findSyntaxNodes, syntaxNodeText } from "./syntaxNodes.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./syntaxTree.js";

export interface PlpgsqlRoutineVariable {
  name: string;
  isParam: boolean;
  isConst: boolean;
  typeName: string;
  declareLine: number;
}

export interface ParsedPlpgsqlRoutine {
  statementStartLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
  variables: PlpgsqlRoutineVariable[];
}

interface RoutineSyntax {
  statement: SyntaxNode;
  bodyLiteral: SyntaxNode;
  parameters: PlpgsqlRoutineVariable[];
}

export async function analyzePlpgsqlSource(
  source: string,
  parser: SyntaxParser,
): Promise<ParsedPlpgsqlRoutine[]> {
  const syntax = await parser.parse({ language: "sql", source, uri: "document.sql" });
  if (syntax.hasError || syntax.truncated) return [];

  const routines: ParsedPlpgsqlRoutine[] = [];
  for (const candidate of routineSyntax(source, syntax)) {
    const body = decodeSqlLiteral(syntaxNodeText(source, candidate.bodyLiteral));
    const analysis = await analyzeFunction(body, parser);
    routines.push({
      statementStartLine: candidate.statement.start.line - 1,
      bodyStartLine: candidate.bodyLiteral.start.line - 1,
      bodyEndLine: candidate.bodyLiteral.end.line - 1,
      variables: [
        ...candidate.parameters,
        ...analysis.variables.map((variable) => ({
          name: variable.name,
          isParam: false,
          isConst: variable.isConst,
          typeName: variable.type,
          declareLine: variable.line,
        })),
      ],
    });
  }
  return routines;
}

export async function plpgsqlRoutineBodyStartLine(
  source: string,
  parser: SyntaxParser,
): Promise<number | undefined> {
  const syntax = await parser.parse({
    language: "sql",
    source,
    uri: "document.sql",
    maxDepth: 16,
    maxNodes: 512,
    namedOnly: true,
  });
  if (syntax.hasError) return undefined;
  const routines = routineSyntax(source, syntax);
  return routines.length === 1 ? routines[0].bodyLiteral.start.line - 1 : undefined;
}

function routineSyntax(source: string, syntax: SyntaxTree): RoutineSyntax[] {
  const candidates = [
    ...findSyntaxNodes(syntax.root, "CreateFunctionStmt"),
    ...findSyntaxNodes(syntax.root, "CreateProcedureStmt"),
    ...findSyntaxNodes(syntax.root, "DoStmt"),
  ].sort((left, right) => left.byteRange[0] - right.byteRange[0]);
  const routines: RoutineSyntax[] = [];
  for (const statement of candidates) {
    const isDo = statement.kind === "DoStmt";
    if (!isDo && sqlRoutineLanguage(source, statement) !== "plpgsql") continue;
    const bodyLiteral = sqlRoutineBodyLiteral(statement, isDo);
    if (!bodyLiteral) continue;
    routines.push({
      statement,
      bodyLiteral,
      parameters: isDo
        ? []
        : sqlRoutineParameters(source, statement)
            .filter(({ mode, name }) => mode !== "out" && mode !== "table" && name !== null)
            .map(({ name, type }) => ({
              name: name!,
              isParam: true,
              isConst: false,
              typeName: type,
              declareLine: 0,
            })),
    });
  }
  return routines;
}
