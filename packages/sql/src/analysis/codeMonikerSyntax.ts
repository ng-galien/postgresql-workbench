import type {
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

export function createCodeMonikerSyntaxParser(client: CodeMonikerSyntaxClient): SyntaxParser {
  return {
    async parse(request: SyntaxParseRequest): Promise<SyntaxTree> {
      const result = await client.queryData(
        {
          op: "syntax_parse",
          language: request.language,
          source: request.source,
          ...(request.uri === undefined ? {} : { uri: request.uri }),
          max_depth: request.maxDepth ?? 32,
          max_nodes: request.maxNodes ?? 2_000,
          named_only: request.namedOnly ?? false,
          include_text: false,
          max_text_chars: 0,
        },
        "syntax_tree",
      );
      return mapSyntaxTree(result);
    },
  };
}

function mapSyntaxTree(tree: CodeMonikerSyntaxTree): SyntaxTree {
  return {
    file: tree.file,
    language: tree.language,
    focus: tree.focus,
    focusLineRange: tree.focus_line_range,
    root: mapSyntaxNode(tree.root),
    emittedNodes: tree.emitted_nodes,
    totalNodes: tree.total_nodes,
    maxDepth: tree.max_depth,
    truncated: tree.truncated,
    hasError: tree.has_error,
  };
}

function mapSyntaxNode(node: CodeMonikerSyntaxNode): SyntaxNode {
  return {
    kind: node.kind,
    language: node.language ?? null,
    named: node.named,
    error: node.error,
    missing: node.missing,
    byteRange: node.byte_range,
    start: mapSyntaxPoint(node.start),
    end: mapSyntaxPoint(node.end),
    text: node.text,
    children: node.children.map(mapSyntaxNode),
  };
}

function mapSyntaxPoint(point: CodeMonikerSyntaxPoint): SyntaxPoint {
  return {
    line: point.line,
    column: point.column,
  };
}
