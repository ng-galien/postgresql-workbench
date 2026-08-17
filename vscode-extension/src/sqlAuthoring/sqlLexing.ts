export interface SqlWord {
  depth: number;
  value: string;
}

export interface SqlLexicalScan {
  dollarQuotedRanges: SqlDollarQuotedRange[];
  maskedSource: string;
  statementSeparators: number[];
  topLevelSource: string;
  words: SqlWord[];
}

export interface SqlDollarQuotedRange {
  contentEnd: number;
  contentStart: number;
  end: number;
  start: number;
  tag: string;
}

export interface PostgresPlpgsqlRange {
  end: number;
  start: number;
}

export interface SqlStatementSlice {
  start: number;
  end: number;
  text: string;
}

export interface SqlStatementRunSlice extends SqlStatementSlice {
  line: number;
}

export function sqlStatementSlices(source: string): SqlStatementRunSlice[] {
  const scan = scanPostgresSql(source);
  const boundaries = [...scan.statementSeparators.map((separator) => separator + 1), source.length];
  const statements: SqlStatementRunSlice[] = [];
  let start = 0;
  for (const end of boundaries) {
    const masked = scan.maskedSource.slice(start, end);
    const firstCode = masked.search(/[^\s;]/u);
    if (firstCode >= 0) {
      const statementStart = start + firstCode;
      statements.push({
        start,
        end,
        text: source.slice(start, end).trim(),
        line: source.slice(0, statementStart).split("\n").length,
      });
    }
    start = end;
  }
  return statements;
}

export function sqlStatementAtOffset(source: string, requestedOffset: number): SqlStatementSlice {
  const offset = Math.max(0, Math.min(source.length, requestedOffset));
  const separators = scanPostgresSql(source).statementSeparators;
  const previous = [...separators].reverse().find((separator) => separator < offset);
  const next = separators.find((separator) => separator >= offset);
  const start = previous === undefined ? 0 : previous + 1;
  const end = next === undefined ? source.length : next + 1;
  return { start, end, text: source.slice(start, end) };
}

export function scanPostgresSql(source: string): SqlLexicalScan {
  const masked = source.split("");
  const topLevel = source.split("");
  const statementSeparators: number[] = [];
  const words: SqlWord[] = [];
  const dollarQuotedRanges: SqlDollarQuotedRange[] = [];
  let depth = 0;
  let quote: "single" | "double" | "line-comment" | undefined;
  let escapedString = false;
  let blockCommentDepth = 0;
  let dollarTag: string | undefined;
  let dollarStart: number | undefined;
  const mask = (start: number, length = 1) => {
    for (let index = start; index < start + length; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
        topLevel[index] = " ";
      }
    }
  };
  const maskTopLevel = (start: number, length = 1) => {
    for (let index = start; index < start + length; index += 1) {
      if (topLevel[index] !== "\n" && topLevel[index] !== "\r") topLevel[index] = " ";
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (depth > 0) maskTopLevel(index);
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        if (dollarStart !== undefined) {
          dollarQuotedRanges.push({
            contentEnd: index,
            contentStart: dollarStart + dollarTag.length,
            end: index + dollarTag.length,
            start: dollarStart,
            tag: dollarTag,
          });
        }
        mask(index, dollarTag.length);
        index += dollarTag.length - 1;
        dollarTag = undefined;
        dollarStart = undefined;
      } else {
        mask(index);
      }
      continue;
    }
    if (quote === "line-comment") {
      if (current === "\n") quote = undefined;
      else mask(index);
      continue;
    }
    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        mask(index, 2);
        blockCommentDepth += 1;
        index += 1;
      } else if (current === "*" && next === "/") {
        mask(index, 2);
        blockCommentDepth -= 1;
        index += 1;
      } else {
        mask(index);
      }
      continue;
    }
    if (quote === "single") {
      if (escapedString && current === "\\") {
        mask(index, 2);
        index += 1;
      } else if (current === "'" && next === "'") {
        mask(index, 2);
        index += 1;
      } else if (current === "'") {
        mask(index);
        quote = undefined;
        escapedString = false;
      } else {
        mask(index);
      }
      continue;
    }
    if (quote === "double") {
      if (current === '"' && next === '"') {
        if (depth > 0) maskTopLevel(index, 2);
        index += 1;
      } else if (current === '"') {
        quote = undefined;
      } else {
        masked[index] = "_";
        if (depth === 0) topLevel[index] = "_";
      }
      continue;
    }
    if (current === "-" && next === "-") {
      mask(index, 2);
      quote = "line-comment";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      mask(index, 2);
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (
      (current === "E" || current === "e") &&
      next === "'" &&
      !/[A-Za-z0-9_$]/u.test(source[index - 1] ?? "")
    ) {
      mask(index, 2);
      quote = "single";
      escapedString = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      mask(index);
      quote = "single";
      escapedString = false;
      continue;
    }
    if (current === '"') {
      quote = "double";
      continue;
    }
    if (current === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(source.slice(index));
      if (match) {
        mask(index, match[0].length);
        dollarTag = match[0];
        dollarStart = index;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (current === ";") {
      statementSeparators.push(index);
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(source.slice(index));
    if (!word) continue;
    words.push({ depth, value: word[0].toLocaleLowerCase() });
    if (depth > 0) maskTopLevel(index, word[0].length);
    index += word[0].length - 1;
  }
  return {
    dollarQuotedRanges,
    maskedSource: masked.join(""),
    statementSeparators,
    topLevelSource: topLevel.join(""),
    words,
  };
}

export function postgresPlpgsqlRanges(source: string): PostgresPlpgsqlRange[] {
  const scan = scanPostgresSql(source);
  return scan.dollarQuotedRanges.flatMap((range) => {
    const prefix = scan.maskedSource.slice(0, range.start);
    if (!/\bDO(?:\s+LANGUAGE\s+plpgsql)?\s*$/iu.test(prefix)) return [];
    return [{ start: range.contentStart, end: range.contentEnd }];
  });
}
