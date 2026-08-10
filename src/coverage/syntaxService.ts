import type { SyntaxNode, SyntaxParser, SyntaxTree } from "../analysis/syntaxTree.js";
import { CoverageInstrumentationError } from "./errors.js";
import type { CoverageAnalysis, InstrumentedCoverageDdl } from "./model.js";
import { analyzeCoverageSyntax } from "./syntaxAnalyzer.js";
import { instrumentCoverageSyntaxBody } from "./syntaxInstrumenter.js";

export { CoverageInstrumentationError } from "./errors.js";

const TRANSACTION_SCAN_MAX_DEPTH = 4;
const TRANSACTION_SCAN_MAX_NODES = 2_000;

export interface CoverageSourceAnalysis {
  analysis: CoverageAnalysis;
  procedureTransactionControl: boolean;
}

export interface CoverageInstrumentationRequest {
  ddl: string;
  source: string;
  analysis: CoverageAnalysis;
  runId: string;
}

export interface CoverageSyntaxService {
  analyze(source: string): Promise<CoverageSourceAnalysis>;
  instrument(request: CoverageInstrumentationRequest): Promise<InstrumentedCoverageDdl>;
  containsSqlTransactionControl(sql: string): Promise<boolean>;
}

export function createCoverageSyntaxService(
  getParser: () => Promise<SyntaxParser>,
): CoverageSyntaxService {
  let parserPromise: Promise<SyntaxParser> | undefined;
  const parser = (): Promise<SyntaxParser> => {
    parserPromise ??= getParser();
    return parserPromise;
  };
  return {
    async analyze(source) {
      const syntax = await (await parser()).parse({
        language: "plpgsql",
        source,
        uri: "coverage.plpgsql",
      });
      return {
        analysis: analyzeCoverageSyntax(source, syntax),
        procedureTransactionControl:
          !syntax.hasError &&
          !syntax.truncated &&
          containsAnyKind(syntax.root, ["stmt_commit", "stmt_rollback"]),
      };
    },
    async instrument(request) {
      const syntaxParser = await parser();
      const ddlSyntax = await syntaxParser.parse({
        language: "sql",
        source: request.ddl,
        uri: "coverage.sql",
      });
      assertUsable(ddlSyntax, "coverage.ddl-invalid", "The routine DDL could not be parsed.");
      const embeddedBody = embeddedPlpgsqlBody(ddlSyntax, request.ddl, request.source);
      if (!embeddedBody) {
        throw syntaxError(
          "coverage.body-mismatch",
          "The SQL syntax tree does not contain the authoritative PostgreSQL source in one PL/pgSQL body.",
        );
      }
      const instrumented = instrumentCoverageSyntaxBody(
        request.source,
        request.analysis,
        request.runId,
      );
      const ddl = replaceUtf8Range(request.ddl, embeddedBody.byteRange, instrumented.body);
      const validation = await syntaxParser.parse({
        language: "sql",
        source: ddl,
        uri: "coverage.generated.sql",
      });
      assertUsable(
        validation,
        "coverage.generated-source-invalid",
        "The generated coverage DDL is not valid SQL or PL/pgSQL.",
      );
      return { ...instrumented, ddl, bodyStartLine: embeddedBody.startLine };
    },
    async containsSqlTransactionControl(sql) {
      const syntax = await (await parser()).parse({
        language: "sql",
        source: sql,
        uri: "coverage-test.sql",
        maxDepth: TRANSACTION_SCAN_MAX_DEPTH,
        maxNodes: TRANSACTION_SCAN_MAX_NODES,
        namedOnly: true,
      });
      assertTransactionScanUsable(
        syntax,
        "coverage.test-sql-invalid",
        "The pgTAP callback SQL could not be parsed safely.",
      );
      return containsAnyKind(syntax.root, ["TransactionStmt"]);
    },
  };
}

function embeddedPlpgsqlBody(
  tree: SyntaxTree,
  ddl: string,
  source: string,
): { byteRange: [number, number]; startLine: number } | undefined {
  const containers = findNodes(
    tree.root,
    (node) =>
      node.kind === "dollar_quoted_string" &&
      findNodes(
        node,
        (candidate) => candidate.kind === "source_file" && candidate.language === "plpgsql",
      ).length === 1,
  );
  if (containers.length !== 1) return undefined;
  const ddlBuffer = Buffer.from(ddl, "utf8");
  const sourceBuffer = Buffer.from(source, "utf8");
  const [containerStart, containerEnd] = containers[0].byteRange;
  const container = ddlBuffer.subarray(containerStart, containerEnd);
  const relativeStart = container.indexOf(sourceBuffer);
  if (relativeStart < 0) return undefined;
  if (container.indexOf(sourceBuffer, relativeStart + 1) >= 0) return undefined;
  const start = containerStart + relativeStart;
  return {
    byteRange: [start, start + sourceBuffer.length],
    startLine: countNewlinesBeforeByte(ddlBuffer, start),
  };
}

function countNewlinesBeforeByte(source: Buffer, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index++) {
    if (source[index] === 10) count++;
  }
  return count;
}

function containsAnyKind(root: SyntaxNode, kinds: readonly string[]): boolean {
  const expected = new Set(kinds);
  return findNodes(root, (node) => expected.has(node.kind)).length > 0;
}

function findNodes(root: SyntaxNode, predicate: (node: SyntaxNode) => boolean): SyntaxNode[] {
  const result = predicate(root) ? [root] : [];
  for (const child of root.children) result.push(...findNodes(child, predicate));
  return result;
}

function assertUsable(tree: SyntaxTree, code: string, message: string): void {
  if (tree.truncated) throw syntaxError(code, `${message} The syntax tree was truncated.`);
  if (tree.hasError) throw syntaxError(code, `${message} The syntax tree contains errors.`);
}

function assertTransactionScanUsable(tree: SyntaxTree, code: string, message: string): void {
  if (tree.hasError) throw syntaxError(code, `${message} The syntax tree contains errors.`);
  if (
    tree.truncated &&
    (tree.maxDepth < TRANSACTION_SCAN_MAX_DEPTH || tree.emittedNodes >= TRANSACTION_SCAN_MAX_NODES)
  ) {
    throw syntaxError(code, `${message} The shallow syntax tree exhausted its safety bounds.`);
  }
}

function replaceUtf8Range(source: string, range: [number, number], replacement: string): string {
  const buffer = Buffer.from(source, "utf8");
  return Buffer.concat([
    buffer.subarray(0, range[0]),
    Buffer.from(replacement, "utf8"),
    buffer.subarray(range[1]),
  ]).toString("utf8");
}

function syntaxError(code: string, message: string): CoverageInstrumentationError {
  return new CoverageInstrumentationError([{ severity: "error", code, message }]);
}
