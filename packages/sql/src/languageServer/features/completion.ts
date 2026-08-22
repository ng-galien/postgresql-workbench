import type { CompletionItem, Position } from "vscode-languageserver/node";
import { CompletionItemKind, InsertTextFormat } from "vscode-languageserver/node";
import type { SqlCaretRole, SqlRelationMention } from "../../query/relations.js";
import type { SqlQueryShape } from "../../query/shape.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "../../snapshot.js";
import {
  canonicalSqlIdentifier,
  quoteSqlIdentifierIfNeeded,
  unquoteSqlIdentifierFragment,
} from "../../text/identifiers.js";
import { positionAtOffset } from "../../text/positions.js";
import {
  postgresPlpgsqlRanges,
  scanPostgresSql,
  sqlStatementAtOffset,
} from "../../text/sqlLexing.js";
import { POSTGRES_STATEMENT_PHRASES } from "../../text/vocabulary.js";

const MAX_COMPLETIONS = 200;
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
  const caret: CompletionCaret = { source, offset };
  const relationPosition = caretRole === "relation";
  if (relationPosition) {
    if (qualifier) {
      const qualifiedSuffix = `${qualifier[1]}.${qualifier[2]}`;
      const suffixOffset = (qualifier.index ?? 0) + qualifier[0].lastIndexOf(qualifiedSuffix);
      const ownerToken = before.slice(suffixOffset, suffixOffset + qualifier[1].length);
      const fragmentToken = before.slice(suffixOffset + qualifier[1].length + 1);
      const owner = canonicalSqlIdentifier(ownerToken);
      return replacing(
        boundedCompletions(
          snapshot.objects
            .filter(
              (object) =>
                object.schema === owner && (object.kind === "table" || object.kind === "view"),
            )
            .map((object) => objectCompletion(object, false)),
          unquoteSqlIdentifierFragment(fragmentToken),
        ),
        caret,
        typedFragmentLength(before),
      );
    }
    return replacing(
      boundedCompletions(
        snapshot.objects
          .filter((object) => object.kind === "table" || object.kind === "view")
          .map((object) => objectCompletion(object)),
        completionFragment(before),
      ),
      caret,
      typedFragmentLength(before),
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
    const typed = typedFragmentLength(before);
    if (alias) {
      return replacing(boundedCompletions(columnCompletions(alias.object), fragment), caret, typed);
    }
    return replacing(
      boundedCompletions(
        snapshot.objects
          .filter((object) => object.schema === owner)
          .map((object) => objectCompletion(object, false)),
        fragment,
      ),
      caret,
      typed,
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
  return namesThenLanguage(items, before, caret);
}

/**
 * Everything the index knows, then the language, each bounded apart from the other: the bound
 * exists so a large catalog cannot flood the widget, and the language is a fixed handful of words
 * that a large catalog must not push out of it.
 *
 * A name replaces the fragment the caret sits at the end of. A phrase replaces as much of what is
 * already typed as it continues, which is more than that fragment as soon as it is several words.
 */
function namesThenLanguage(
  items: CompletionItem[],
  before: string,
  caret: CompletionCaret,
): CompletionItem[] {
  const fragment = completionFragment(before);
  return [
    ...replacing(boundedCompletions(items, fragment), caret, typedFragmentLength(before)),
    ...replacingEach(boundedCompletions(PHRASE_COMPLETIONS, fragment), caret, (item) =>
      phraseReplacementLength(before, String(item.label)),
    ),
  ];
}

/**
 * The language, as items: what the `text` layer says a statement is written with, offered after
 * everything the index knows. A reader completing inside their own query names their own schema
 * more often than the language holding it, so `sortText` says so where a widget sorts, and the
 * order of the answer says so where one does not. Built once: the language does not change
 * between keystrokes.
 */
const PHRASE_COMPLETIONS: CompletionItem[] = POSTGRES_STATEMENT_PHRASES.map((phrase) => ({
  label: phrase,
  kind: CompletionItemKind.Keyword,
  insertText: phrase,
  sortText: `z${phrase}`,
}));

/** The text a proposal is written into, and where in it the caret sits. */
interface CompletionCaret {
  source: string;
  offset: number;
}

/**
 * What a proposal replaces, said by the server instead of left for each client to guess.
 *
 * A client with nothing to go on falls back to the word the caret sits at the end of. That is
 * right for a name and wrong for a phrase: `IS NOT NULL` chosen after `id is n` would replace the
 * `n` alone and leave `id is IS NOT NULL`. The server knows both the text and what it is
 * proposing, so it is the one place where the span can be right for every proposal and every
 * client — the Data View webview and a VS Code editor alike.
 */
function replacingEach(
  items: CompletionItem[],
  caret: CompletionCaret,
  lengthOf: (item: CompletionItem) => number,
): CompletionItem[] {
  const end = positionAtOffset(caret.source, caret.offset);
  /*
   * A span is a place in the document, and finding one means counting the lines before it. Most
   * proposals replace the same span as the one before, so each length is counted once however many
   * proposals share it — two hundred names always do.
   */
  const starts = new Map<number, Position>();
  const startOf = (length: number) => {
    const known = starts.get(length);
    if (known) return known;
    const start = positionAtOffset(caret.source, caret.offset - length);
    starts.set(length, start);
    return start;
  };
  return items.map((item) => ({
    ...item,
    textEdit: {
      range: { start: startOf(lengthOf(item)), end },
      newText: item.insertText ?? String(item.label),
    },
  }));
}

/** Every proposal of a branch replaces the same span: the fragment the caret sits at the end of. */
function replacing(
  items: CompletionItem[],
  caret: CompletionCaret,
  length: number,
): CompletionItem[] {
  return replacingEach(items, caret, () => length);
}

/**
 * The identifier fragment the caret sits at the end of, as typed: an opening quote and what
 * follows it, or the bare word. Length, not text, because it is a span of the document — what a
 * fragment means once unquoted and folded is `completionFragment`'s question.
 */
function typedFragmentLength(before: string): number {
  const quoted = /"[^"]*$/u.exec(before);
  if (quoted) return quoted[0].length;
  return /[\w$]*$/u.exec(before)?.[0].length ?? 0;
}

/**
 * How much of what is already typed a phrase continues: the longest suffix of the text before the
 * caret that the phrase starts with, taken at a word boundary. `id is n` hands `IS NOT NULL` its
 * four last characters; `an` hands `AND` its two. A phrase that continues nothing replaces the
 * fragment at the caret, like a name.
 */
function phraseReplacementLength(before: string, phrase: string): number {
  const spoken = phrase.toLocaleLowerCase();
  const typed = before.toLocaleLowerCase();
  for (let length = Math.min(typed.length, spoken.length); length > 0; length -= 1) {
    const start = typed.length - length;
    const previous = start === 0 ? undefined : typed[start - 1];
    if (previous !== undefined && /[\w$"]/u.test(previous)) continue;
    if (spoken.startsWith(typed.slice(start))) return length;
  }
  return typedFragmentLength(before);
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
    if (relation.catalogSchema === undefined) continue;
    const schema = relation.catalogSchema;
    const name = relation.catalogName;
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
