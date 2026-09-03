/**
 * Hover over a SQL reference: the indexed object it names, and the command link that reveals it
 * in the host's Workbench Sources. Resolution happens against the Workbench Index snapshot with
 * alias scoping per statement, exactly as composition sees the query.
 */
import type { DocumentMentions } from "../../query/relations.js";
import type { SqlAuthoringSnapshot } from "../../snapshot.js";
import { canonicalSqlIdentifier } from "../../text/identifiers.js";
import { sqlStatementAtOffset, sqlStatementSlices } from "../../text/sqlLexing.js";
import { REVEAL_SQL_REFERENCE_COMMAND, type SqlAuthoringNavigationTarget } from "../protocol.js";

export interface SqlNavigationReference {
  label: string;
  target: SqlAuthoringNavigationTarget;
  /** Character range of the referenced name in the analyzed source. */
  range: { start: number; end: number };
}

type SnapshotObject = SqlAuthoringSnapshot["objects"][number];
type Mentions = Pick<DocumentMentions, "relations" | "columns" | "routines">;

/** Aliases are scoped to their Statement: the same name may denote another relation further down. */
export function postgresSqlReferences(
  source: string,
  snapshot: SqlAuthoringSnapshot,
  mentions: Mentions,
): SqlNavigationReference[] {
  return sqlStatementSlices(source).flatMap((statement) =>
    statementNavigationReferences(snapshot, mentions, statement),
  );
}

/** The single reference under the given offset: only its own Statement can resolve it. */
export function postgresSqlReferenceAt(
  source: string,
  snapshot: SqlAuthoringSnapshot,
  mentions: Mentions,
  offset: number,
): SqlNavigationReference | undefined {
  return statementNavigationReferences(
    snapshot,
    mentions,
    sqlStatementAtOffset(source, offset),
  ).find(({ range }) => range.start <= offset && offset <= range.end);
}

function statementNavigationReferences(
  snapshot: SqlAuthoringSnapshot,
  mentions: Mentions,
  statement: { start: number; end: number },
): SqlNavigationReference[] {
  const within = <T extends { nameRange: { start: number; end: number } }>(
    candidates: readonly T[],
  ) =>
    candidates.filter(
      (mention) =>
        mention.nameRange.start >= statement.start && mention.nameRange.end <= statement.end,
    );
  return statementReferences(
    snapshot,
    within(mentions.relations),
    within(mentions.columns),
    within(mentions.routines),
  );
}

/** The Markdown a hover shows for one reference: its qualified name, and the reveal link. */
export function postgresHoverMarkdown(reference: SqlNavigationReference): string {
  const command = `command:${REVEAL_SQL_REFERENCE_COMMAND}?${encodeURIComponent(
    JSON.stringify([reference.target]),
  )}`;
  return `**${reference.label}**\n\n[Reveal in Workbench Sources](${command})`;
}

/**
 * References of one Statement, with its own alias scope. A relation position names a table or a
 * view; only when no relation carries that name does it name a routine, as in
 * `CALL shop.move_inventory(…)` — homonyms resolve to the relation.
 */
function statementReferences(
  snapshot: SqlAuthoringSnapshot,
  relations: Mentions["relations"],
  columns: Mentions["columns"],
  routines: Mentions["routines"],
): SqlNavigationReference[] {
  const references: SqlNavigationReference[] = [];
  const aliases = new Map<string, SnapshotObject>();
  for (const relation of relations) {
    if (relation.schema === undefined) continue;
    const schema = canonicalSqlIdentifier(relation.schema);
    const name = canonicalSqlIdentifier(relation.name);
    const named = snapshot.objects.filter(
      (candidate) => candidate.schema === schema && candidate.name === name,
    );
    const object =
      named.find((candidate) => candidate.kind === "table" || candidate.kind === "view") ??
      named.find((candidate) => candidate.kind === "function" || candidate.kind === "procedure");
    if (!object) continue;
    const nameLength = relation.name.length;
    references.push(sqlReference(relation.nameRange.end - nameLength, nameLength, object));
    if (object.kind === "table" || object.kind === "view") {
      aliases.set(canonicalSqlIdentifier(relation.reference), object);
    }
  }
  for (const routine of routines) {
    if (routine.schema === undefined) continue;
    const schema = canonicalSqlIdentifier(routine.schema);
    const name = canonicalSqlIdentifier(routine.name);
    const object = snapshot.objects.find(
      (candidate) =>
        (candidate.kind === "function" || candidate.kind === "procedure") &&
        candidate.schema === schema &&
        candidate.name === name,
    );
    if (!object) continue;
    references.push(
      sqlReference(
        routine.nameRange.start,
        routine.nameRange.end - routine.nameRange.start,
        object,
      ),
    );
  }
  for (const column of columns) {
    const name = canonicalSqlIdentifier(column.name);
    const owner =
      column.qualifier === undefined
        ? soleOwnerOf(name, aliases)
        : aliases.get(canonicalSqlIdentifier(column.qualifier));
    if (!owner?.columns.some((candidate) => candidate.name === name)) continue;
    references.push(
      sqlReference(
        column.nameRange.start,
        column.nameRange.end - column.nameRange.start,
        owner,
        name,
      ),
    );
  }
  return references;
}

/** The only relation of the query that has this column, when exactly one does. */
function soleOwnerOf(
  name: string,
  aliases: ReadonlyMap<string, SnapshotObject>,
): SnapshotObject | undefined {
  const owners = new Map(
    [...aliases.values()]
      .filter((object) => object.columns.some((column) => column.name === name))
      .map((object) => [object.oid, object]),
  );
  return owners.size === 1 ? [...owners.values()][0] : undefined;
}

function sqlReference(
  offset: number,
  length: number,
  object: SnapshotObject,
  column?: string,
): SqlNavigationReference {
  return {
    label: column ? `${object.schema}.${object.name}.${column}` : `${object.schema}.${object.name}`,
    range: { start: offset, end: offset + length },
    target: {
      ...(column === undefined ? {} : { column }),
      database: object.database,
      oid: object.oid,
      connectionId: object.connectionId,
    },
  };
}
