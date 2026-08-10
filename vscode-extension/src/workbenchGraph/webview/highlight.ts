import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemedTokenWithVariants,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import sql from "@shikijs/langs/sql";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import plpgsqlGrammar from "../../../syntaxes/plpgsql.tmLanguage.json";

export interface PostgresSourceToken {
  text: string;
  offset: number;
  lightColor?: string;
  darkColor?: string;
}

export interface PostgresSourceLine {
  number: number;
  tokens: PostgresSourceToken[];
}

export interface HighlightedPostgresSource {
  lines: PostgresSourceLine[];
  highlighted: boolean;
}

let highlighterPromise: Promise<HighlighterCore> | undefined;

export async function highlightPostgresSource(
  lines: ReadonlyArray<{ number: number; text: string }>,
): Promise<HighlightedPostgresSource> {
  const code = lines.map((line) => line.text).join("\n");
  try {
    const highlighter = await postgresHighlighter();
    const tokenLines = highlighter.codeToTokensWithThemes(code, {
      lang: "plpgsql",
      themes: { light: "light-plus", dark: "dark-plus" },
    });
    return {
      highlighted: true,
      lines: lines.map((line, index) => ({
        number: line.number,
        tokens: sourceTokens(tokenLines[index], line.text),
      })),
    };
  } catch {
    return plainPostgresSource(lines);
  }
}

export function plainPostgresSource(
  lines: ReadonlyArray<{ number: number; text: string }>,
): HighlightedPostgresSource {
  return {
    highlighted: false,
    lines: lines.map((line) => ({
      number: line.number,
      tokens: line.text ? [{ text: line.text, offset: 0 }] : [],
    })),
  };
}

function sourceTokens(
  tokens: ThemedTokenWithVariants[] | undefined,
  fallback: string,
): PostgresSourceToken[] {
  if (!tokens) return fallback ? [{ text: fallback, offset: 0 }] : [];
  return tokens.map((token) => ({
    text: token.content,
    offset: token.offset,
    lightColor: token.variants.light?.color,
    darkColor: token.variants.dark?.color,
  }));
}

function postgresHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [lightPlus, darkPlus],
    langs: [
      sql,
      {
        ...plpgsqlGrammar,
        name: "plpgsql",
        displayName: "PL/pgSQL",
        aliases: ["pgsql", "postgresql"],
        patterns: withSqlFallback(plpgsqlGrammar.patterns),
      },
    ],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function withSqlFallback(patterns: ReadonlyArray<{ include: string }>): Array<{ include: string }> {
  const functionCalls = patterns.findIndex((pattern) => pattern.include === "#function-call");
  const insertion = functionCalls < 0 ? patterns.length : functionCalls;
  return [...patterns.slice(0, insertion), { include: "source.sql" }, ...patterns.slice(insertion)];
}
