import {
  type PostgresAnalysisIdentity,
  type PostgresShapeRange,
  type PostgresSyntaxTarget,
  postgresAnalysisIdentity,
  type SyntaxLanguage,
} from "./postgresSyntax.js";
import type { SyntaxLanguageRegion, SyntaxNode, SyntaxTree } from "./syntaxTree.js";
import { byteToUtf16Offsets } from "./textOffsets.js";

export type { PostgresShapeRange } from "./postgresSyntax.js";

export interface PostgresIdentityRegionProjection {
  kind: "identity";
  documentRange: PostgresShapeRange;
  analysisRange: PostgresShapeRange;
}

export interface PostgresUnavailableRegionProjection {
  kind: "unavailable";
  documentRange: PostgresShapeRange;
  reason: string;
}

export type PostgresRegionProjection =
  | PostgresIdentityRegionProjection
  | PostgresUnavailableRegionProjection;

export type PostgresLanguageRegionKind = "document" | "embedded-sql" | "parser-injection";

export type PostgresRegionSyntaxTarget =
  | { status: "available"; target: PostgresSyntaxTarget }
  | { status: "unavailable"; reason: "syntax-provider-did-not-report-entry-point" };

export interface PostgresLanguageRegionShape {
  /** Unique and deterministic only within this immutable document shape. */
  id: string;
  language: SyntaxLanguage;
  kind: PostgresLanguageRegionKind;
  /** Grammar entry point for prediction; it is never inferred from source text or node names. */
  target: PostgresRegionSyntaxTarget;
  /** Recursive parser status for this exact region; absent means the provider did not prove it. */
  hasError?: boolean;
  /** UTF-16 offsets in the LSP analysis document. */
  sourceRange: PostgresShapeRange;
  /** Exact parsed text, absent when the syntax port cannot project it to the document. */
  analysisSource?: string;
  /** Identity of `analysisSource`, absent exactly when that source is unavailable. */
  analysisIdentity?: PostgresAnalysisIdentity;
  projection: PostgresRegionProjection;
  children: readonly PostgresLanguageRegionShape[];
}

export interface PostgresDocumentShape {
  root: PostgresLanguageRegionShape;
  truncated: boolean;
}

interface PostgresCaretShapeBase {
  regionId: string;
  language: SyntaxLanguage;
  sourceRange: PostgresShapeRange;
}

export interface PostgresProjectedCaretShape extends PostgresCaretShapeBase {
  status: "projected";
  /** UTF-16 offset in the selected region's `analysisSource`. */
  analysisOffset: number;
}

export interface PostgresUnprojectableCaretShape extends PostgresCaretShapeBase {
  status: "unprojectable";
  reason: string;
}

export type PostgresCaretShape = PostgresProjectedCaretShape | PostgresUnprojectableCaretShape;

/**
 * Reduces the parser's explicit language injections into the application shape used by the LSP.
 * A missing injection stays missing: this layer never guesses a language from text or node names.
 */
export function postgresDocumentShape(source: string, tree: SyntaxTree): PostgresDocumentShape {
  const utf16Offset = byteToUtf16Offsets(source);
  const rootRange = { start: 0, end: source.length };
  const rootLanguage = syntaxLanguage(tree.language);
  assertTargetLanguage(rootLanguage, tree.target, "document");
  const children = tree.root.children.flatMap((child, index) =>
    injectedRegions(child, source, utf16Offset, rootLanguage, [index]),
  );
  assertValidChildren(rootRange, children, "document");
  return {
    root: {
      id: regionId(rootLanguage, [], rootRange),
      language: rootLanguage,
      kind: "document",
      target: { status: "available", target: tree.target },
      hasError: tree.hasError,
      sourceRange: rootRange,
      analysisSource: source,
      analysisIdentity: postgresAnalysisIdentity(source),
      projection: identityProjection(rootRange),
      children,
    },
    truncated: tree.truncated,
  };
}

/** The deepest parser-proven language region containing the caret. */
export function postgresCaretShape(
  shape: PostgresDocumentShape,
  documentOffset: number,
): PostgresCaretShape | undefined {
  if (!containsRoot(shape.root.sourceRange, documentOffset)) return undefined;
  let selected = shape.root;
  while (true) {
    const child = childAtCaret(selected.children, documentOffset);
    if (!child) break;
    selected = child;
  }
  const base = {
    regionId: selected.id,
    language: selected.language,
    sourceRange: selected.sourceRange,
  };
  switch (selected.projection.kind) {
    case "identity":
      return {
        ...base,
        status: "projected",
        analysisOffset: documentOffsetToAnalysisOffset(selected.projection, documentOffset),
      };
    case "unavailable":
      return { ...base, status: "unprojectable", reason: selected.projection.reason };
  }
}

function injectedRegions(
  node: SyntaxNode,
  source: string,
  utf16Offset: (byte: number) => number,
  parentLanguage: SyntaxLanguage,
  path: readonly number[],
): PostgresLanguageRegionShape[] {
  if (node.languageRegion) {
    const sourceRange = {
      start: utf16Offset(node.byteRange[0]),
      end: utf16Offset(node.byteRange[1]),
    };
    const language = node.languageRegion.language;
    const projection = regionProjection(node.languageRegion, sourceRange);
    const children =
      projection.kind === "identity"
        ? node.children.flatMap((child, index) =>
            injectedRegions(child, source, utf16Offset, language, [...path, index]),
          )
        : [];
    assertValidChildren(sourceRange, children, `region ${path.join(".")}`);
    return [
      {
        id: regionId(language, path, sourceRange),
        language,
        kind:
          language === "sql" && parentLanguage === "plpgsql" ? "embedded-sql" : "parser-injection",
        target: regionSyntaxTarget(node.languageRegion),
        ...(node.languageRegion.hasError === undefined
          ? {}
          : { hasError: node.languageRegion.hasError }),
        sourceRange,
        ...(projection.kind === "identity"
          ? analysisContent(source.slice(sourceRange.start, sourceRange.end))
          : {}),
        projection,
        children,
      },
    ];
  }
  return node.children.flatMap((child, index) =>
    injectedRegions(child, source, utf16Offset, parentLanguage, [...path, index]),
  );
}

function analysisContent(analysisSource: string): {
  analysisSource: string;
  analysisIdentity: PostgresAnalysisIdentity;
} {
  return { analysisSource, analysisIdentity: postgresAnalysisIdentity(analysisSource) };
}

function regionProjection(
  region: SyntaxLanguageRegion,
  sourceRange: PostgresShapeRange,
): PostgresRegionProjection {
  switch (region.projection.kind) {
    case "identity":
      return identityProjection(sourceRange);
    case "unavailable":
      return {
        kind: "unavailable",
        documentRange: sourceRange,
        reason: region.projection.reason,
      };
  }
}

function syntaxLanguage(language: string): SyntaxLanguage {
  if (language === "sql" || language === "plpgsql") return language;
  throw new Error(`Unsupported PostgreSQL document language: ${language}`);
}

function assertTargetLanguage(
  language: SyntaxLanguage,
  target: PostgresSyntaxTarget,
  subject: string,
): void {
  if (language !== target.language) {
    throw new Error(
      `Mismatched ${subject} language and syntax target: ${language}/${target.language}`,
    );
  }
}

function regionSyntaxTarget(region: SyntaxLanguageRegion): PostgresRegionSyntaxTarget {
  switch (region.language) {
    case "sql":
      return region.entryPoint === undefined
        ? {
            status: "unavailable",
            reason: "syntax-provider-did-not-report-entry-point",
          }
        : {
            status: "available",
            target: { language: "sql", entryPoint: region.entryPoint },
          };
    case "plpgsql":
      return region.entryPoint === undefined
        ? {
            status: "unavailable",
            reason: "syntax-provider-did-not-report-entry-point",
          }
        : {
            status: "available",
            target: { language: "plpgsql", entryPoint: region.entryPoint },
          };
  }
}

function identityProjection(sourceRange: PostgresShapeRange): PostgresIdentityRegionProjection {
  return {
    kind: "identity",
    documentRange: sourceRange,
    analysisRange: { start: 0, end: sourceRange.end - sourceRange.start },
  };
}

function regionId(
  language: SyntaxLanguage,
  path: readonly number[],
  range: PostgresShapeRange,
): string {
  return `${language}:${path.join(".") || "root"}:${range.start}-${range.end}`;
}

function documentOffsetToAnalysisOffset(
  projection: PostgresIdentityRegionProjection,
  documentOffset: number,
): number {
  switch (projection.kind) {
    case "identity":
      return projection.analysisRange.start + (documentOffset - projection.documentRange.start);
  }
}

function containsRoot(range: PostgresShapeRange, offset: number): boolean {
  return offset >= range.start && offset <= range.end;
}

function childAtCaret(
  children: readonly PostgresLanguageRegionShape[],
  offset: number,
): PostgresLanguageRegionShape | undefined {
  return (
    children.find(({ sourceRange }) => sourceRange.start === offset) ??
    children.find(({ sourceRange }) => offset > sourceRange.start && offset < sourceRange.end) ??
    children.find(({ sourceRange }) => sourceRange.end === offset)
  );
}

function assertValidChildren(
  parent: PostgresShapeRange,
  children: readonly PostgresLanguageRegionShape[],
  subject: string,
): void {
  let previous: PostgresLanguageRegionShape | undefined;
  for (const child of children) {
    if (
      child.sourceRange.start < parent.start ||
      child.sourceRange.end > parent.end ||
      child.sourceRange.end < child.sourceRange.start
    ) {
      throw new Error(`Invalid language region outside ${subject}: ${child.id}`);
    }
    if (
      previous &&
      (child.sourceRange.start < previous.sourceRange.end ||
        (child.sourceRange.start === previous.sourceRange.start &&
          child.sourceRange.end === child.sourceRange.start))
    ) {
      throw new Error(`Overlapping language regions in ${subject}: ${previous.id}, ${child.id}`);
    }
    previous = child;
  }
}
