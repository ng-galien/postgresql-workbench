import type { PostgresSyntaxTarget, SyntaxLanguage } from "./postgresSyntax.js";

export type { SyntaxLanguage } from "./postgresSyntax.js";

/**
 * A parser-proven language region in the source document.
 *
 * This is a Workbench port contract, not a parser-vendor DTO: only the root of
 * an injected language region carries this fact, its byte range is absolute in
 * the requested source, and `identity` means the parser analyzed that exact
 * source slice without decoding or rewriting it.
 */
export type SyntaxRegionProjection = { kind: "identity" } | { kind: "unavailable"; reason: string };

export type SyntaxLanguageRegion =
  | {
      language: "sql";
      /** Absent until the syntax provider exposes the parser-proven injected entry point. */
      entryPoint?: "script" | "statement" | "expression";
      /** Recursive parser status for this exact region; absent means the provider did not prove it. */
      hasError?: boolean;
      projection: SyntaxRegionProjection;
    }
  | {
      language: "plpgsql";
      /** Absent until the syntax provider exposes the parser-proven injected entry point. */
      entryPoint?: "block";
      /** Recursive parser status for this exact region; absent means the provider did not prove it. */
      hasError?: boolean;
      projection: SyntaxRegionProjection;
    };

export interface SyntaxPoint {
  line: number;
  column: number;
}

export interface SyntaxNode {
  kind: string;
  /** Low-level parser metadata. Application code must use `languageRegion`. */
  language: string | null;
  languageRegion?: SyntaxLanguageRegion;
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
  /** Entry point selected by the parse request; nested regions carry their own entry point. */
  target: PostgresSyntaxTarget;
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
