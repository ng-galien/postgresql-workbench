import type { CompletionItem } from "vscode-languageserver/node";
import { CompletionItemKind, InsertTextFormat } from "vscode-languageserver/node";
import {
  canonicalSqlIdentifier,
  requiresQuotedPostgresIdentifier,
  unquoteSqlIdentifierFragment,
} from "./identifiers.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "./protocol.js";
import type { SqlCaretRole, SqlRelationMention } from "./query/relations.js";
import type { SqlQueryShape } from "./queryShape.js";
import { postgresPlpgsqlRanges, scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

const MAX_COMPLETIONS = 200;
const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/u;
export function postgresCompletions(
  source: string,
  offset: number,
  snapshot: SqlAuthoringSnapshot,
  relations: readonly SqlRelationMention[] = [],
  caretRole?: SqlCaretRole,
  shape?: SqlQueryShape,
): CompletionItem[] {
  const plpgsqlRange = postgresPlpgsqlRanges(source).find(
    (range) => offset >= range.start && offset <= range.end,
  );
  const scopeStart = plpgsqlRange?.start ?? 0;
  const scopeSource = plpgsqlRange ? source.slice(plpgsqlRange.start, plpgsqlRange.end) : source;
  const statement = sqlStatementAtOffset(scopeSource, offset - scopeStart);
  if (!plpgsqlRange && shape?.hasNestedQuery) return [];
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
  const relationPosition = caretRole === "relation";
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

  const aliases = queryAliases(relations, snapshot.objects);
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

/** Quotes only where PostgreSQL requires it, for the SQL a user reads in the editor. */
export function quoteSqlIdentifierIfNeeded(identifier: string): string {
  if (SIMPLE_IDENTIFIER.test(identifier) && !requiresQuotedPostgresIdentifier(identifier)) {
    return identifier;
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

interface QueryAlias {
  object: SqlAuthoringObject;
  reference: string;
}

/** Alias map of the statement, built from the relations the syntax tree reports. */
function queryAliases(
  relations: readonly SqlRelationMention[],
  objects: readonly SqlAuthoringObject[],
): Map<string, QueryAlias> {
  const aliases = new Map<string, QueryAlias>();
  for (const relation of relations) {
    if (relation.schema === undefined) continue;
    const schema = canonicalSqlIdentifier(relation.schema);
    const name = canonicalSqlIdentifier(relation.name);
    const candidates = objects.filter(
      (candidate) =>
        candidate.name === name &&
        candidate.schema === schema &&
        (candidate.kind === "table" || candidate.kind === "view"),
    );
    const object = candidates.length === 1 ? candidates[0] : undefined;
    if (!object) continue;
    aliases.set(canonicalSqlIdentifier(relation.reference), {
      object,
      reference: relation.reference,
    });
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
      ? `${qualified ? `${quoteSqlIdentifierIfNeeded(object.schema)}.` : ""}${quoteSqlIdentifierIfNeeded(object.name)}(${parameters.join(", ")})`
      : `${qualified ? `${quoteSqlIdentifierIfNeeded(object.schema)}.` : ""}${quoteSqlIdentifierIfNeeded(object.name)}`,
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
      ? `${reference}.${quoteSqlIdentifierIfNeeded(column.name)}`
      : quoteSqlIdentifierIfNeeded(column.name),
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
