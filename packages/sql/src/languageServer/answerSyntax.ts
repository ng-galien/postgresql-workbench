import { postgresDocumentSyntaxFactsFromTree } from "../analysis/documentFacts.js";
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
  /** Explicit root grammar. Omission preserves the SQL behavior used by formatting/composition. */
  language?: "sql" | "plpgsql";
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
): Promise<SqlAuthoringSyntaxResult> {
  const { uri, source, caret } = request;
  if (request.language === "plpgsql") {
    const tree = await parser.parse({
      language: "plpgsql",
      source,
      uri,
      maxDepth: settings.syntaxMaxDepth,
      maxNodes: settings.syntaxMaxNodes,
      namedOnly: false,
    });
    const facts = postgresDocumentSyntaxFactsFromTree(source, tree);
    return {
      hasError: tree.hasError,
      truncated: tree.truncated,
      facts,
      plpgsqlBody: true,
    };
  }
  const {
    source: parsedSource,
    relations,
    facts,
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
      facts,
    };
  }
  const errorLine = firstSyntaxErrorLine(syntax.root);
  return {
    hasError: true,
    truncated: false,
    ...(errorLine === undefined ? {} : { errorLine }),
    relations,
    ...(caretRole === undefined ? {} : { caretRole }),
    facts,
  };
}
