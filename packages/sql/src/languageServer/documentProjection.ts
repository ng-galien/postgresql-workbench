import { SemanticTokensBuilder } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SqlAuthoringDocumentProjection } from "./protocol.js";
import { decodeSemanticTokenData } from "./protocol.js";

/** One visible document and the statement the language server analyzes on its behalf. */
export interface ProjectedSqlDocument {
  visible: TextDocument;
  analysis: TextDocument;
  projection?: SqlAuthoringDocumentProjection;
  visibleStart: number;
  visibleEnd: number;
}

/**
 * Builds the single document projection used by every language-server feature. A normal SQL file
 * is its own analysis document; an embedded WHERE condition is surrounded by host-owned SQL.
 */
export function projectedSqlDocument(
  visible: TextDocument,
  projection?: SqlAuthoringDocumentProjection,
): ProjectedSqlDocument {
  if (!projection) {
    return {
      visible,
      analysis: visible,
      visibleStart: 0,
      visibleEnd: visible.getText().length,
    };
  }
  const source = visible.getText();
  const visibleStart = projection.prefix.length;
  const analysis = TextDocument.create(
    visible.uri,
    visible.languageId,
    visible.version,
    `${projection.prefix}${source}${projection.suffix}`,
  );
  return {
    visible,
    analysis,
    projection,
    visibleStart,
    visibleEnd: visibleStart + source.length,
  };
}

/** Offset of the visible caret in the statement analyzed by the server. */
export function analysisOffsetOf(document: ProjectedSqlDocument, visibleOffset: number): number {
  return document.visibleStart + visibleOffset;
}

/**
 * Carries semantic tokens wholly inside the visible fragment back to its own coordinate space.
 * A token crossing the projection boundary is host-owned and is intentionally not exposed.
 */
export function projectSemanticTokenData(
  document: ProjectedSqlDocument,
  data: ArrayLike<number>,
): number[] {
  if (!document.projection) return Array.from(data);
  const builder = new SemanticTokensBuilder();
  for (const token of decodeSemanticTokenData(data)) {
    const at = document.analysis.offsetAt(token);
    if (at < document.visibleStart || at + token.length > document.visibleEnd) continue;
    const visiblePosition = document.visible.positionAt(at - document.visibleStart);
    builder.push(
      visiblePosition.line,
      visiblePosition.character,
      token.length,
      token.tokenType,
      token.tokenModifiers,
    );
  }
  return builder.build().data;
}
