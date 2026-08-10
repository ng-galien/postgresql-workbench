export type SyntaxLanguage = "sql" | "plpgsql";

export interface SyntaxPoint {
  line: number;
  column: number;
}

export interface SyntaxNode {
  kind: string;
  language: string | null;
  named: boolean;
  error: boolean;
  missing: boolean;
  byteRange: [number, number];
  start: SyntaxPoint;
  end: SyntaxPoint;
  text: string | null;
  children: SyntaxNode[];
}

export interface SyntaxTree {
  file: string;
  language: string;
  focus: string;
  focusLineRange: [number, number] | null;
  root: SyntaxNode;
  emittedNodes: number;
  totalNodes: number;
  maxDepth: number;
  truncated: boolean;
  hasError: boolean;
}

export interface SyntaxParseRequest {
  language: SyntaxLanguage;
  source: string;
  uri?: string;
  maxDepth?: number;
  maxNodes?: number;
  namedOnly?: boolean;
}

export interface SyntaxParser {
  parse(request: SyntaxParseRequest): Promise<SyntaxTree>;
}
