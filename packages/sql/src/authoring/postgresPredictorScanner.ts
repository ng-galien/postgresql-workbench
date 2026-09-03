import type {
  PlpgsqlKeywordCategory,
  PostgresSqlKeywordCategory,
} from "../analysis/postgresKeywordCatalog.js";

export type PostgresPredictorDialect = "sql" | "plpgsql";

export interface PostgresPredictorLexeme {
  terminal: string;
  start: number;
  end: number;
  written: string;
  canonical?: string;
  form: "keyword" | "identifier" | "quoted-identifier" | "other";
  keywordCategory?: PostgresSqlKeywordCategory | PlpgsqlKeywordCategory;
}

export interface PostgresPredictorScan {
  tokens: readonly PostgresPredictorLexeme[];
  error: boolean;
  truncated: boolean;
}

export interface PostgresPredictorKeyword {
  token: string;
  category: PostgresSqlKeywordCategory | PlpgsqlKeywordCategory;
}

export interface PostgresPredictorScannerProfile {
  identifierTerminal: "IDENT" | "T_WORD";
  keywords: ReadonlyMap<string, PostgresPredictorKeyword>;
  remapLookahead: boolean;
}

const SPECIAL_OPERATOR = new Map([
  ["::", "TYPECAST"],
  ["..", "DOT_DOT"],
  [":=", "COLON_EQUALS"],
  ["=>", "EQUALS_GREATER"],
  ["<=", "LESS_EQUALS"],
  [">=", "GREATER_EQUALS"],
  ["<>", "NOT_EQUALS"],
  ["!=", "NOT_EQUALS"],
]);

const SELF_CHARACTERS = new Set(",()[].;:+-*/%^<>=?");
const OPERATOR_CHARACTERS = new Set("~!@#%^&|`?+-*/<>=");

/**
 * Host-neutral lexical projection used only by the completion predictor. It follows PostgreSQL's
 * public terminal vocabulary: words are classified by the checked-in kwlists, quoted names keep
 * their exact spelling, comments are discarded, and every remaining token is named exactly as it
 * is in `gram.y` or `pl_gram.y`.
 */
export function scanPostgresPredictorSource(
  source: string,
  profile: PostgresPredictorScannerProfile,
  maxTokens: number,
): PostgresPredictorScan {
  const tokens: PostgresPredictorLexeme[] = [];
  let index = 0;
  let error = false;

  const emit = (token: PostgresPredictorLexeme): boolean => {
    if (tokens.length === maxTokens) return false;
    tokens.push(token);
    return true;
  };

  while (index < source.length) {
    const start = index;
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (/\s/u.test(current)) {
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) error = true;
      continue;
    }

    const dollarQuote = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(source.slice(index));
    if (dollarQuote) {
      const delimiter = dollarQuote[0];
      const close = source.indexOf(delimiter, index + delimiter.length);
      if (close < 0) {
        error = true;
        break;
      }
      index = close + delimiter.length;
      if (!emit(other("SCONST", source, start, index))) break;
      continue;
    }

    const parameter = /^\$[0-9]+/u.exec(source.slice(index));
    if (parameter) {
      index += parameter[0].length;
      if (!emit(other("PARAM", source, start, index))) break;
      continue;
    }

    const unicodeQuoted =
      (current === "U" || current === "u") && next === "&" && source[index + 2] === '"';
    if (current === '"' || unicodeQuoted) {
      const quote = unicodeQuoted ? index + 2 : index;
      index = quote + 1;
      let canonical = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          canonical += '"';
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          canonical += source[index];
          index += 1;
        }
      }
      // PostgreSQL authoring deliberately accepts an unfinished quoted identifier at the caret.
      if (!closed && index !== source.length) error = true;
      if (
        !emit({
          terminal: profile.identifierTerminal,
          start,
          end: index,
          written: source.slice(start, index),
          canonical,
          form: "quoted-identifier",
        })
      )
        break;
      continue;
    }

    const stringPrefix = stringPrefixAt(source, index);
    if (current === "'" || stringPrefix) {
      const quote = stringPrefix ? index + stringPrefix.length : index;
      const terminal =
        stringPrefix?.toLocaleLowerCase() === "b"
          ? "BCONST"
          : stringPrefix?.toLocaleLowerCase() === "x"
            ? "XCONST"
            : "SCONST";
      index = quote + 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else if (stringPrefix?.toLocaleLowerCase() === "e" && source[index] === "\\") {
          index = Math.min(source.length, index + 2);
        } else index += 1;
      }
      if (!closed) {
        error = true;
        break;
      }
      if (tokens.at(-1)?.terminal === "UESCAPE") {
        const escapeCharacter = source.slice(quote + 1, index - 1).replaceAll("''", "'");
        if (!validUnicodeEscapeCharacter(escapeCharacter)) {
          error = true;
          break;
        }
      }
      if (!emit(other(terminal, source, start, index))) break;
      continue;
    }

    const number =
      /^(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+|[0-9]+)/u.exec(
        source.slice(index),
      );
    if (number) {
      index += number[0].length;
      const terminal = /[.eE]/u.test(number[0]) ? "FCONST" : "ICONST";
      if (!emit(other(terminal, source, start, index))) break;
      continue;
    }

    const word = /^[_\p{L}][_$\p{L}\p{N}\p{M}]*/u.exec(source.slice(index));
    if (word) {
      index += word[0].length;
      const canonical = word[0].toLocaleLowerCase();
      const keyword = profile.keywords.get(canonical);
      if (
        !emit(
          keyword
            ? {
                terminal: keyword.token,
                start,
                end: index,
                written: word[0],
                canonical,
                form: "keyword",
                keywordCategory: keyword.category,
              }
            : {
                terminal: profile.identifierTerminal,
                start,
                end: index,
                written: word[0],
                canonical,
                form: "identifier",
              },
        )
      )
        break;
      continue;
    }

    const special = SPECIAL_OPERATOR.get(source.slice(index, index + 2));
    if (special) {
      index += 2;
      if (!emit(other(special, source, start, index))) break;
      continue;
    }

    if (OPERATOR_CHARACTERS.has(current)) {
      index += 1;
      while (index < source.length && OPERATOR_CHARACTERS.has(source[index] ?? "")) index += 1;
      const written = source.slice(start, index);
      const terminal = written.length === 1 && SELF_CHARACTERS.has(written) ? quote(written) : "Op";
      if (!emit(other(terminal, source, start, index))) break;
      continue;
    }

    if (SELF_CHARACTERS.has(current)) {
      index += 1;
      if (!emit(other(quote(current), source, start, index))) break;
      continue;
    }

    error = true;
    break;
  }

  const truncated = tokens.length === maxTokens && index < source.length;
  return {
    tokens: profile.remapLookahead ? remapSqlLookahead(tokens) : tokens,
    error,
    truncated,
  };
}

function validUnicodeEscapeCharacter(value: string): boolean {
  return value.length === 1 && !/[0-9A-Fa-f+'"\s]/u.test(value);
}

function stringPrefixAt(source: string, index: number): string | undefined {
  const prefix = /^(?:[eEbBxXnN]|[uU]&)(?=')/u.exec(source.slice(index));
  if (!prefix) return undefined;
  const previous = source[index - 1] ?? "";
  return /[_$\p{L}\p{N}\p{M}]/u.test(previous) ? undefined : prefix[0];
}

function other(
  terminal: string,
  source: string,
  start: number,
  end: number,
): PostgresPredictorLexeme {
  return { terminal, start, end, written: source.slice(start, end), form: "other" };
}

function quote(character: string): string {
  return `'${character.replaceAll("'", "\\'")}'`;
}

function remapSqlLookahead(
  input: readonly PostgresPredictorLexeme[],
): readonly PostgresPredictorLexeme[] {
  return input.map((token, index) => {
    const next = input[index + 1]?.terminal;
    const terminal =
      token.terminal === "NOT" &&
      next !== undefined &&
      ["BETWEEN", "IN_P", "LIKE", "ILIKE", "SIMILAR"].includes(next)
        ? "NOT_LA"
        : token.terminal === "NULLS_P" && (next === "FIRST_P" || next === "LAST_P")
          ? "NULLS_LA"
          : token.terminal === "WITH" && (next === "TIME" || next === "ORDINALITY")
            ? "WITH_LA"
            : token.terminal === "WITHOUT" && next === "TIME"
              ? "WITHOUT_LA"
              : token.terminal === "FORMAT" && next === "JSON"
                ? "FORMAT_LA"
                : token.terminal;
    return terminal === token.terminal ? token : { ...token, terminal };
  });
}
