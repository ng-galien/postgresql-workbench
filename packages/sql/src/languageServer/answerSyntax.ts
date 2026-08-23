import { firstSyntaxErrorLine } from "../analysis/syntaxNodes.js";
import type { SyntaxParser } from "../analysis/syntaxTree.js";
import { analyzeSqlQuery } from "../query/analysis.js";
import { documentRelations } from "../query/relations.js";
import type { SqlAuthoringSettings } from "../snapshot.js";
import type { SqlAuthoringSyntaxResult } from "./protocol.js";

/** What the server asks its host for: the syntax of a document it cannot parse itself. */
export interface SqlAuthoringSyntaxRequest {
  uri: string;
  source: string;
  /** Offset being typed: a placeholder goes there so an unfinished statement still parses. */
  caret?: number;
}

/**
 * The host half of `postgresql-workbench/syntax`. The language server runs in its own process and
 * has no parser, so it sends every completion, every semantic token and every composition back
 * here. Nothing in this answer needs VS Code — only whether the document is a bare PL/pgSQL body,
 * which the caller knows and this does not.
 */
export async function answerSyntaxRequest(
  request: SqlAuthoringSyntaxRequest,
  parser: SyntaxParser,
  settings: SqlAuthoringSettings,
  isPlpgsqlDocument?: (uri: string) => boolean,
): Promise<SqlAuthoringSyntaxResult> {
  const { uri, source, caret } = request;
  const {
    source: parsedSource,
    relations,
    caretRole,
  } = await documentRelations(parser, source, {
    uri,
    maxDepth: settings.syntaxMaxDepth,
    maxNodes: settings.syntaxMaxNodes,
    ...(caret === undefined ? {} : { caret }),
  });
  const budget = {
    source: parsedSource,
    uri,
    maxDepth: settings.syntaxMaxDepth,
    maxNodes: settings.syntaxMaxNodes,
    namedOnly: true,
  };
  const syntax = await parser.parse({ language: "sql", ...budget });
  if (!syntax.hasError || syntax.truncated) {
    // The composition engine rewrites from this analysis; it never scans the text itself.
    const analyzed = syntax.truncated
      ? undefined
      : await analyzeSqlQuery(source, parser, {
          uri,
          maxDepth: settings.syntaxMaxDepth,
          maxNodes: settings.syntaxMaxNodes,
        });
    return {
      hasError: syntax.hasError,
      truncated: syntax.truncated,
      ...(analyzed?.status === "ok" ? { analysis: analyzed.analysis } : {}),
      ...(analyzed?.shape === undefined ? {} : { shape: analyzed.shape }),
      relations,
      ...(caretRole === undefined ? {} : { caretRole }),
    };
  }
  const plpgsqlBody =
    isPlpgsqlDocument?.(uri) === true &&
    !(await parser.parse({ language: "plpgsql", ...budget })).hasError;
  const errorLine = firstSyntaxErrorLine(syntax.root);
  return {
    hasError: true,
    truncated: false,
    ...(errorLine === undefined ? {} : { errorLine }),
    ...(plpgsqlBody ? { plpgsqlBody } : {}),
    relations,
    ...(caretRole === undefined ? {} : { caretRole }),
  };
}
