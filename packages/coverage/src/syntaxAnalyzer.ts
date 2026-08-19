import {
  directSyntaxChild as directChild,
  directSyntaxChildren as directChildren,
  findSyntaxNodes as findAll,
  findSyntaxNode as findFirst,
  syntaxNodeText,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "../../sql/src/analysis/syntaxTree.js";
import type {
  CoverageAnalysis,
  CoverageDiagnostic,
  CoveragePoint,
  CoverageProbePlacement,
  CoverageStatementLabel,
} from "./model.js";

const STATEMENT_LABELS: Readonly<Record<string, CoverageStatementLabel>> = {
  stmt_assert: "assert",
  stmt_assign: "assign",
  stmt_call: "call",
  stmt_close: "close",
  stmt_dynexecute: "dynexecute",
  stmt_execsql: "execsql",
  stmt_exit: "exit",
  stmt_fetch: "fetch",
  stmt_for: "for",
  stmt_foreach_a: "foreach",
  stmt_getdiag: "getdiag",
  stmt_loop: "loop",
  stmt_open: "open",
  stmt_perform: "perform",
  stmt_raise: "raise",
  stmt_while: "while",
};

const LOOP_KINDS = new Set(["stmt_loop", "stmt_while", "stmt_for", "stmt_foreach_a"]);

interface AnalyzerState {
  source: string;
  points: CoveragePoint[];
  diagnostics: CoverageDiagnostic[];
  nextPoint: number;
}

interface StatementLocation {
  line: number;
  siteKey: string;
  byteOffset: number;
}

export async function analyzeCoverageWithSyntaxParser(
  source: string,
  parser: SyntaxParser,
): Promise<CoverageAnalysis> {
  try {
    const syntax = await parser.parse({
      language: "plpgsql",
      source,
      uri: "coverage.plpgsql",
    });
    return analyzeCoverageSyntax(source, syntax);
  } catch (error) {
    return parseFailure(
      "coverage.parse-error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function analyzeCoverageSyntax(source: string, syntax: SyntaxTree): CoverageAnalysis {
  if (syntax.truncated) {
    return parseFailure(
      "coverage.parse-truncated",
      "The PL/pgSQL syntax tree was truncated and cannot be analyzed safely.",
    );
  }
  if (syntax.hasError) {
    return parseFailure("coverage.parse-error", "The source contains PL/pgSQL syntax errors.");
  }
  const block = findFirst(syntax.root, "pl_block");
  if (!block) {
    return parseFailure(
      "coverage.no-postgresql-workbench-function",
      "The source does not contain a parseable PL/pgSQL routine.",
    );
  }

  const state: AnalyzerState = {
    source,
    points: [],
    diagnostics: [],
    nextPoint: 0,
  };
  analyzeBlock(block, state, "root");
  detectAmbiguousLineSites(state);
  const declarationSection = directChild(block, "decl_sect");
  const declarationKeyword = declarationSection
    ? findFirst(declarationSection, "kw_declare")
    : undefined;
  const beginKeyword = directChild(block, "kw_begin");
  const declaration = declarationKeyword
    ? { kind: "append" as const, byteOffset: declarationKeyword.byteRange[1] }
    : beginKeyword
      ? { kind: "insert" as const, byteOffset: beginKeyword.byteRange[0] }
      : undefined;
  return {
    points: state.points,
    diagnostics: state.diagnostics,
    ...(declaration ? { instrumentation: { declaration } } : {}),
  };
}

function analyzeBlock(block: SyntaxNode, state: AnalyzerState, path: string): void {
  const body = directChild(block, "proc_sect");
  if (body) {
    analyzeSection(body, state, path);
  }
  const exceptions = descendantsWithinBlock(block, "proc_exception");
  for (let index = 0; index < exceptions.length; index++) {
    analyzeException(exceptions[index], state, `${path}.exception.${index}`);
  }
}

function analyzeSection(section: SyntaxNode, state: AnalyzerState, path: string): void {
  const statements = directChildren(section, "proc_stmt");
  for (let index = 0; index < statements.length; index++) {
    analyzeStatement(statements[index], state, `${path}.${index}`);
  }
}

function analyzeStatement(wrapper: SyntaxNode, state: AnalyzerState, path: string): void {
  const directBlock = directChild(wrapper, "pl_block");
  if (directBlock) {
    analyzeBlock(directBlock, state, `${path}.block`);
    return;
  }
  const statement = wrapper.children.find((child) => child.kind.startsWith("stmt_"));
  if (!statement) {
    return;
  }

  const label = statementLabel(statement);
  if (label) {
    addPoint(
      state,
      statement.start.line,
      "statement",
      label,
      {
        kind: "before",
        line: statement.start.line,
        siteKey: path,
        byteOffset: statement.byteRange[0],
      },
      statementCoverageEndLine(statement),
    );
  }

  if (statement.kind === "stmt_if") {
    analyzeIf(statement, state, path);
    return;
  }
  if (statement.kind === "stmt_case") {
    analyzeCase(statement, state, path);
    return;
  }
  if (LOOP_KINDS.has(statement.kind)) {
    analyzeLoop(statement, state, path);
    return;
  }
  if (statement.kind === "stmt_block") {
    const block = directChild(statement, "pl_block") ?? findFirst(statement, "pl_block");
    if (block) {
      analyzeBlock(block, state, `${path}.block`);
    }
  }
}

function statementCoverageEndLine(statement: SyntaxNode): number {
  if (!LOOP_KINDS.has(statement.kind)) return statement.end.line;
  const bodyIndex = statement.children.findIndex((child) => child.kind === "loop_body");
  if (bodyIndex <= 0) return statement.start.line;
  return statement.children
    .slice(0, bodyIndex)
    .reduce((endLine, child) => Math.max(endLine, child.end.line), statement.start.line);
}

function analyzeIf(statement: SyntaxNode, state: AnalyzerState, path: string): void {
  const decisionLine = statement.start.line;
  const thenSection = directChild(statement, "proc_sect");
  const thenLocation = thenSection
    ? firstStatementLocation(thenSection, `${path}.if.then`)
    : undefined;
  if (thenLocation) {
    addPoint(state, decisionLine, "branch", `IF true @${decisionLine}`, {
      kind: "before",
      line: thenLocation.line,
      siteKey: thenLocation.siteKey,
      byteOffset: thenLocation.byteOffset,
    });
  }

  const elsifClauses = directChildren(statement, "elsif_clause");
  const elsifSections: SyntaxNode[] = [];
  for (let index = 0; index < elsifClauses.length; index++) {
    const clause = elsifClauses[index];
    const section = directChild(clause, "proc_sect");
    if (!section) {
      continue;
    }
    elsifSections.push(section);
    const location = firstStatementLocation(section, `${path}.if.elsif.${index}`);
    if (location) {
      addPoint(state, clause.start.line, "branch", `ELSIF true @${clause.start.line}`, {
        kind: "before",
        line: location.line,
        siteKey: location.siteKey,
        byteOffset: location.byteOffset,
      });
    }
  }

  const elseClause = directChild(statement, "else_clause");
  const elseSection = elseClause ? directChild(elseClause, "proc_sect") : undefined;
  const elseLocation = elseSection
    ? firstStatementLocation(elseSection, `${path}.if.else`)
    : undefined;
  if (elseLocation) {
    addPoint(state, decisionLine, "branch", `ELSE @${decisionLine}`, {
      kind: "before",
      line: elseLocation.line,
      siteKey: elseLocation.siteKey,
      byteOffset: elseLocation.byteOffset,
    });
  }

  if (thenSection) {
    analyzeSection(thenSection, state, `${path}.if.then`);
  }
  for (let index = 0; index < elsifSections.length; index++) {
    analyzeSection(elsifSections[index], state, `${path}.if.elsif.${index}`);
  }
  if (elseSection) {
    analyzeSection(elseSection, state, `${path}.if.else`);
    return;
  }

  const lastSection = elsifSections.at(-1) ?? thenSection;
  const lastBodyLine = lastSection ? lastStatementLine(lastSection) : undefined;
  const terminator = directChild(statement, "kw_end");
  if (lastBodyLine !== undefined) {
    addPoint(state, decisionLine, "branch", `IF false @${decisionLine}`, {
      kind: "inject_else",
      decisionLine,
      searchAfter: lastBodyLine,
      byteOffset: terminator?.byteRange[0],
    });
  }
}

function analyzeCase(statement: SyntaxNode, state: AnalyzerState, path: string): void {
  const decisionLine = statement.start.line;
  const whenClauses = directChildren(statement, "case_when");
  const whenSections: SyntaxNode[] = [];
  for (let index = 0; index < whenClauses.length; index++) {
    const clause = whenClauses[index];
    const section = directChild(clause, "proc_sect");
    if (!section) {
      continue;
    }
    whenSections.push(section);
    const location = firstStatementLocation(section, `${path}.case.${index}`);
    if (location) {
      addPoint(state, clause.start.line, "branch", `WHEN @${clause.start.line}`, {
        kind: "before",
        line: location.line,
        siteKey: location.siteKey,
        byteOffset: location.byteOffset,
      });
    }
  }

  const hasElse = statement.children.some((child) => child.kind === "kw_else");
  const elseSection = hasElse
    ? statement.children.find((child) => child.kind === "proc_sect")
    : undefined;
  const elseLocation = elseSection
    ? firstStatementLocation(elseSection, `${path}.case.else`)
    : undefined;
  if (elseLocation) {
    addPoint(state, decisionLine, "branch", `CASE ELSE @${decisionLine}`, {
      kind: "before",
      line: elseLocation.line,
      siteKey: elseLocation.siteKey,
      byteOffset: elseLocation.byteOffset,
    });
  } else if (!hasElse) {
    state.diagnostics.push({
      severity: "warning",
      code: "coverage.case-without-else",
      line: decisionLine,
      message:
        "CASE without ELSE keeps PostgreSQL's CASE_NOT_FOUND behavior; its unmatched edge is not instrumented.",
    });
  }

  for (let index = 0; index < whenSections.length; index++) {
    analyzeSection(whenSections[index], state, `${path}.case.${index}`);
  }
  if (elseSection) {
    analyzeSection(elseSection, state, `${path}.case.else`);
  }
}

function analyzeLoop(statement: SyntaxNode, state: AnalyzerState, path: string): void {
  const body = directChild(statement, "loop_body");
  const section = body ? directChild(body, "proc_sect") : undefined;
  const first = section ? firstStatementLocation(section, `${path}.loop`) : undefined;
  if (!first || !section || !body) {
    state.diagnostics.push({
      severity: "warning",
      code: "coverage.empty-loop",
      line: statement.start.line,
      message: "An empty loop has no stable location for an entry probe.",
    });
    return;
  }

  const lastBodyLine = lastStatementLine(section) ?? first.line;
  addPoint(state, statement.start.line, "branch", `loop enter @${statement.start.line}`, {
    kind: "loop_enter",
    loopLine: statement.start.line,
    line: first.line,
    searchAfter: lastBodyLine,
    siteKey: first.siteKey,
    loopByteOffset: statement.byteRange[0],
    byteOffset: first.byteOffset,
  });
  if (statement.kind !== "stmt_loop") {
    addPoint(state, statement.start.line, "branch", `loop exit @${statement.start.line}`, {
      kind: "loop_exit",
      loopLine: statement.start.line,
      searchAfter: lastBodyLine,
      byteOffset: body.byteRange[1],
    });
  }
  analyzeSection(section, state, `${path}.loop`);
}

function analyzeException(exception: SyntaxNode, state: AnalyzerState, path: string): void {
  const section = directChild(exception, "proc_sect");
  const first = section ? firstStatementLocation(section, path) : undefined;
  if (!first || !section) {
    return;
  }
  const conditions = findAll(exception, "proc_condition")
    .map((condition) => syntaxNodeText(state.source, condition).trim() || "?")
    .join(", ");
  addPoint(state, first.line, "branch", `EXCEPTION ${conditions}`, {
    kind: "before",
    line: first.line,
    siteKey: first.siteKey,
    byteOffset: first.byteOffset,
  });
  analyzeSection(section, state, path);
}

function statementLabel(statement: SyntaxNode): CoverageStatementLabel | undefined {
  if (statement.kind !== "stmt_return") {
    return STATEMENT_LABELS[statement.kind];
  }
  if (statement.children.some((child) => child.kind === "kw_next")) {
    return "return_next";
  }
  if (statement.children.some((child) => child.kind === "kw_query")) {
    return "return_query";
  }
  return "return";
}

function firstStatementLocation(section: SyntaxNode, path: string): StatementLocation | undefined {
  const statement = directChildren(section, "proc_stmt")[0];
  return statement
    ? {
        line: statement.start.line,
        siteKey: `${path}.0`,
        byteOffset: statement.byteRange[0],
      }
    : undefined;
}

function lastStatementLine(section: SyntaxNode): number | undefined {
  return directChildren(section, "proc_stmt").at(-1)?.start.line;
}

function addPoint(
  state: AnalyzerState,
  line: number,
  kind: CoveragePoint["kind"],
  label: string,
  placement: CoverageProbePlacement,
  endLine = line,
): void {
  state.points.push({
    id: `p${state.nextPoint++}`,
    line,
    endLine,
    kind,
    label,
    placement,
  });
}

function detectAmbiguousLineSites(state: AnalyzerState): void {
  const sitesByLine = new Map<number, Set<string>>();
  for (const point of state.points) {
    const placement = point.placement;
    if (placement.kind !== "before" && placement.kind !== "loop_enter") {
      continue;
    }
    const sites = sitesByLine.get(placement.line) ?? new Set<string>();
    sites.add(placement.siteKey);
    sitesByLine.set(placement.line, sites);
  }
  for (const [line, sites] of sitesByLine) {
    if (sites.size < 2) {
      continue;
    }
    state.diagnostics.push({
      severity: "error",
      code: "coverage.ambiguous-line",
      line,
      message:
        "Multiple independently executable statements share this line; safe line-based instrumentation is not possible.",
    });
  }
}

function descendantsWithinBlock(block: SyntaxNode, kind: string): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (const child of block.children) {
    collectWithinBlock(child, kind, result);
  }
  return result;
}

function collectWithinBlock(node: SyntaxNode, kind: string, result: SyntaxNode[]): void {
  if (node.kind === "pl_block") {
    return;
  }
  if (node.kind === kind) {
    result.push(node);
    return;
  }
  for (const child of node.children) {
    collectWithinBlock(child, kind, result);
  }
}

function parseFailure(code: string, message: string): CoverageAnalysis {
  return {
    points: [],
    diagnostics: [{ severity: "error", code, message }],
  };
}
