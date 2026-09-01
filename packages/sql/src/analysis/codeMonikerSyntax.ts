import type {
  SyntaxLanguage,
  SyntaxLanguageRegion,
  SyntaxNode,
  SyntaxParseRequest,
  SyntaxParser,
  SyntaxPoint,
  SyntaxTree,
} from "./syntaxTree.js";

export interface CodeMonikerSyntaxPoint {
  line: number;
  column: number;
}

export interface CodeMonikerSyntaxNode {
  kind: string;
  language?: string | null;
  entry_point?: "script" | "statement" | "expression" | "block" | null;
  has_error?: boolean | null;
  named: boolean;
  error: boolean;
  missing: boolean;
  byte_range: [number, number];
  start: CodeMonikerSyntaxPoint;
  end: CodeMonikerSyntaxPoint;
  text: string | null;
  children: CodeMonikerSyntaxNode[];
}

export interface CodeMonikerSyntaxTree {
  file: string;
  language: string;
  focus: string;
  focus_line_range: [number, number] | null;
  root: CodeMonikerSyntaxNode;
  emitted_nodes: number;
  total_nodes: number;
  max_depth: number;
  truncated: boolean;
  has_error: boolean;
}

export interface CodeMonikerSyntaxClient {
  queryData(
    request: Record<string, unknown>,
    resultKind: "syntax_tree",
  ): Promise<CodeMonikerSyntaxTree>;
}

/**
 * The provider inlines its language injections into the tree — a routine body, and the SQL
 * regions inside it — so a whole routine reads deeper and larger than the budgets that fit an
 * injection-less parse. The defaults match the SQL authoring server's own.
 */
export const DEFAULT_SYNTAX_MAX_DEPTH = 1_024;
export const DEFAULT_SYNTAX_MAX_NODES = 100_000;

export function createCodeMonikerSyntaxParser(client: CodeMonikerSyntaxClient): SyntaxParser {
  return {
    async parse(request: SyntaxParseRequest): Promise<SyntaxTree> {
      const result = await client.queryData(
        {
          op: "syntax_parse",
          language: request.language,
          source: request.source,
          ...(request.uri === undefined ? {} : { uri: request.uri }),
          max_depth: request.maxDepth ?? DEFAULT_SYNTAX_MAX_DEPTH,
          max_nodes: request.maxNodes ?? DEFAULT_SYNTAX_MAX_NODES,
          named_only: request.namedOnly ?? false,
          include_text: false,
          max_text_chars: 0,
        },
        "syntax_tree",
      );
      return mapSyntaxTree(result, request.language);
    },
  };
}

function mapSyntaxTree(tree: CodeMonikerSyntaxTree, requestedLanguage: SyntaxLanguage): SyntaxTree {
  const language = syntaxLanguage(tree.language, "syntax tree");
  if (language !== requestedLanguage) {
    throw new Error(`Code Moniker returned ${language} for a ${requestedLanguage} parse request`);
  }
  return {
    file: tree.file,
    language,
    target:
      language === "sql"
        ? { language: "sql", entryPoint: "script" }
        : { language: "plpgsql", entryPoint: "block" },
    focus: tree.focus,
    focusLineRange: tree.focus_line_range,
    root: mapSyntaxNode(tree.root, true),
    emittedNodes: tree.emitted_nodes,
    totalNodes: tree.total_nodes,
    maxDepth: tree.max_depth,
    truncated: tree.truncated,
    hasError: tree.has_error,
  };
}

function mapSyntaxNode(node: CodeMonikerSyntaxNode, documentRoot = false): SyntaxNode {
  const injectedLanguage =
    documentRoot || node.language == null ? undefined : supportedSyntaxLanguage(node.language);
  const languageRegion =
    injectedLanguage === undefined
      ? undefined
      : mapLanguageRegion(injectedLanguage, node.entry_point, node.has_error);
  return {
    kind: node.kind,
    language: node.language ?? null,
    ...(languageRegion === undefined ? {} : { languageRegion }),
    named: node.named,
    error: node.error,
    missing: node.missing,
    byteRange: node.byte_range,
    start: mapSyntaxPoint(node.start),
    end: mapSyntaxPoint(node.end),
    text: node.text,
    children: node.children.map((child) => mapSyntaxNode(child)),
  };
}

function mapLanguageRegion(
  language: SyntaxLanguage,
  entryPoint: CodeMonikerSyntaxNode["entry_point"],
  hasError: CodeMonikerSyntaxNode["has_error"],
): SyntaxLanguageRegion {
  if (language === "plpgsql") {
    return {
      language,
      ...(entryPoint === "block" ? { entryPoint } : {}),
      ...(typeof hasError === "boolean" ? { hasError } : {}),
      projection: { kind: "identity" },
    };
  }
  return {
    language,
    ...(entryPoint === "script" || entryPoint === "statement" || entryPoint === "expression"
      ? { entryPoint }
      : {}),
    ...(typeof hasError === "boolean" ? { hasError } : {}),
    projection: { kind: "identity" },
  };
}

function supportedSyntaxLanguage(language: string): SyntaxLanguage | undefined {
  return language === "sql" || language === "plpgsql" ? language : undefined;
}

function syntaxLanguage(language: string, subject: string): SyntaxLanguage {
  const supported = supportedSyntaxLanguage(language);
  if (supported === undefined) {
    throw new Error(`Unsupported ${subject} language: ${language}`);
  }
  return supported;
}

function mapSyntaxPoint(point: CodeMonikerSyntaxPoint): SyntaxPoint {
  return {
    line: point.line,
    column: point.column,
  };
}
