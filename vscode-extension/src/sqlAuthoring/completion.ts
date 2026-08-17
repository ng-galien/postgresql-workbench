import type { CompletionItem } from "vscode-languageserver/node";
import { CompletionItemKind, InsertTextFormat } from "vscode-languageserver/node";
import {
  canonicalSqlIdentifier,
  requiresQuotedPostgresIdentifier,
  splitSqlQualifiedIdentifier,
  sqlAliasAfterRelation,
  unquoteSqlIdentifierFragment,
} from "./identifiers.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "./protocol.js";
import { analyzeSqlQueryShape } from "./queryShape.js";
import { postgresPlpgsqlRanges, scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

const MAX_COMPLETIONS = 200;
const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/u;
export function postgresCompletions(
  source: string,
  offset: number,
  snapshot: SqlAuthoringSnapshot,
): CompletionItem[] {
  const plpgsqlRange = postgresPlpgsqlRanges(source).find(
    (range) => offset >= range.start && offset <= range.end,
  );
  const scopeStart = plpgsqlRange?.start ?? 0;
  const scopeSource = plpgsqlRange ? source.slice(plpgsqlRange.start, plpgsqlRange.end) : source;
  const statement = sqlStatementAtOffset(scopeSource, offset - scopeStart);
  if (!plpgsqlRange && analyzeSqlQueryShape(statement.text).hasNestedQuery) return [];
  const localOffset = Math.max(
    0,
    Math.min(statement.text.length, offset - scopeStart - statement.start),
  );
  const before = statement.text.slice(0, localOffset);
  const lexicalScan = scanPostgresSql(statement.text);
  const maskedStatement = lexicalScan.maskedSource;
  const maskedBefore = maskedStatement.slice(0, localOffset);
  const qualifier = /(?:^|[^\w$])((?:"(?:""|[^"])+"|[\w$]+))\.((?:"(?:""|[^"])*|[\w$]*))$/u.exec(
    maskedBefore,
  );
  const relationPosition = /\b(?:FROM|JOIN)\s+(?:[\w$".]*)$/iu.test(maskedBefore);
  if (relationPosition) {
    if (qualifier) {
      const qualifiedSuffix = `${qualifier[1]}.${qualifier[2]}`;
      const suffixOffset = (qualifier.index ?? 0) + qualifier[0].lastIndexOf(qualifiedSuffix);
      const ownerToken = before.slice(suffixOffset, suffixOffset + qualifier[1].length);
      const fragmentToken = before.slice(suffixOffset + qualifier[1].length + 1);
      const owner = canonicalSqlIdentifier(ownerToken);
      return boundedCompletions(
        snapshot.objects
          .filter(
            (object) =>
              object.schema === owner && (object.kind === "table" || object.kind === "view"),
          )
          .map((object) => objectCompletion(object, false)),
        unquoteSqlIdentifierFragment(fragmentToken),
      );
    }
    return boundedCompletions(
      snapshot.objects
        .filter((object) => object.kind === "table" || object.kind === "view")
        .map((object) => objectCompletion(object)),
      completionFragment(before),
    );
  }

  const aliases = queryAliases(statement.text, lexicalScan.topLevelSource, snapshot.objects);
  if (qualifier) {
    const qualifiedSuffix = `${qualifier[1]}.${qualifier[2]}`;
    const suffixOffset = (qualifier.index ?? 0) + qualifier[0].lastIndexOf(qualifiedSuffix);
    const ownerToken = before.slice(suffixOffset, suffixOffset + qualifier[1].length);
    const fragmentToken = before.slice(suffixOffset + qualifier[1].length + 1);
    const owner = canonicalSqlIdentifier(ownerToken);
    const fragment = unquoteSqlIdentifierFragment(fragmentToken);
    const alias = aliases.get(owner);
    if (alias) return boundedCompletions(columnCompletions(alias.object), fragment);
    return boundedCompletions(
      snapshot.objects
        .filter((object) => object.schema === owner)
        .map((object) => objectCompletion(object, false)),
      fragment,
    );
  }

  const items: CompletionItem[] = [];
  for (const { object, reference } of aliases.values()) {
    items.push({
      label: reference,
      kind: CompletionItemKind.Variable,
      detail: `${object.schema}.${object.name} alias`,
      insertText: `${reference}.`,
      command: { title: "Trigger Suggest", command: "editor.action.triggerSuggest" },
    });
    items.push(...columnCompletions(object, reference));
  }
  for (const object of snapshot.objects) items.push(objectCompletion(object));
  return boundedCompletions(items, completionFragment(before));
}

export function quoteIdentifier(identifier: string): string {
  if (SIMPLE_IDENTIFIER.test(identifier) && !requiresQuotedPostgresIdentifier(identifier)) {
    return identifier;
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

interface QueryAlias {
  object: SqlAuthoringObject;
  reference: string;
}

function queryAliases(
  source: string,
  maskedSource: string,
  objects: readonly SqlAuthoringObject[],
): Map<string, QueryAlias> {
  const aliases = new Map<string, QueryAlias>();
  const from = /\bFROM\b/iu.exec(maskedSource);
  if (!from || from.index === undefined) return aliases;
  const boundary =
    /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW|FETCH|FOR)\b|;/iu.exec(
      maskedSource.slice(from.index + from[0].length),
    );
  const clauseEnd = boundary ? from.index + from[0].length + boundary.index : maskedSource.length;
  const clause = maskedSource.slice(from.index, clauseEnd);
  const pattern =
    /(?:\b(?:FROM|JOIN)\s+|,\s*)((?:"(?:""|[^"])+"|[\w$]+)(?:\.(?:"(?:""|[^"])+"|[\w$]+))?)/giu;
  for (const match of clause.matchAll(pattern)) {
    const relationOffset = from.index + (match.index ?? 0) + match[0].indexOf(match[1]);
    const relation = source.slice(relationOffset, relationOffset + match[1].length);
    const parts = splitSqlQualifiedIdentifier(relation);
    if (parts.length !== 2) continue;
    const schema = canonicalSqlIdentifier(parts[0]);
    const name = canonicalSqlIdentifier(parts[1]);
    const candidates = objects.filter(
      (candidate) =>
        candidate.name === name &&
        candidate.schema === schema &&
        (candidate.kind === "table" || candidate.kind === "view"),
    );
    if (candidates.length !== 1) continue;
    const object = candidates[0];
    const alias =
      sqlAliasAfterRelation(source, maskedSource, relationOffset + match[1].length) ?? parts[1];
    aliases.set(canonicalSqlIdentifier(alias), { object, reference: alias });
  }
  return aliases;
}

function objectCompletion(object: SqlAuthoringObject, qualified = true): CompletionItem {
  const callable = object.kind === "function" || object.kind === "procedure";
  const parameters = object.parameters.map(
    (parameter, index) => `\${${index + 1}:${parameter.name || parameter.type}}`,
  );
  return {
    label: object.name,
    kind: callable
      ? CompletionItemKind.Function
      : object.kind === "view"
        ? CompletionItemKind.Interface
        : CompletionItemKind.Class,
    detail: `${object.kind} ${object.schema}.${object.name}${object.signature ? ` · ${object.signature}` : ""}`,
    insertText: callable
      ? `${qualified ? `${quoteIdentifier(object.schema)}.` : ""}${quoteIdentifier(object.name)}(${parameters.join(", ")})`
      : `${qualified ? `${quoteIdentifier(object.schema)}.` : ""}${quoteIdentifier(object.name)}`,
    insertTextFormat: callable ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    filterText: `${object.name} ${object.schema}.${object.name}`,
  };
}

function columnCompletions(object: SqlAuthoringObject, reference?: string): CompletionItem[] {
  return object.columns.map((column) => ({
    label: column.name,
    kind: CompletionItemKind.Field,
    detail: `${column.type} · ${object.schema}.${object.name}`,
    insertText: reference
      ? `${reference}.${quoteIdentifier(column.name)}`
      : quoteIdentifier(column.name),
    filterText: column.name,
  }));
}

function deduplicate(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${String(item.label)}\0${item.insertText ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function completionFragment(source: string): string {
  const match = /(?:(?:^|[^\w$])"([^"]*)|([\w$]*))$/u.exec(source);
  return (match?.[1] ?? match?.[2] ?? "").toLocaleLowerCase();
}

function boundedCompletions(items: CompletionItem[], requestedFragment: string): CompletionItem[] {
  const fragment = requestedFragment.toLocaleLowerCase();
  const matching = fragment
    ? items.filter((item) => completionTerms(item).some((term) => term.startsWith(fragment)))
    : items;
  return deduplicate(matching).slice(0, MAX_COMPLETIONS);
}

function completionTerms(item: CompletionItem): string[] {
  return [String(item.label), item.filterText ?? ""]
    .flatMap((value) => value.toLocaleLowerCase().split(/[\s.]+/u))
    .filter(Boolean);
}
