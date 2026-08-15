import { quoteIdentifier } from "./completion.js";
import { formatPostgresSql } from "./format.js";
import { canonicalSqlIdentifier, splitSqlQualifiedIdentifier } from "./identifiers.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
  SqlAuthoringForeignKey,
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
} from "./protocol.js";
import { analyzeSqlQueryShape } from "./queryShape.js";
import { scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

const CLAUSE_KEYWORDS = new Set([
  "where",
  "join",
  "left",
  "right",
  "full",
  "inner",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "window",
  "fetch",
  "for",
  "natural",
  "using",
  "tablesample",
]);

export function composePostgresSql(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
): SqlAuthoringComposeResult {
  const statement = sqlStatementAtOffset(request.text, request.offset);
  const result = composePostgresStatement(
    {
      ...request,
      text: statement.text,
      offset: Math.max(0, request.offset - statement.start),
    },
    snapshot,
  );
  if (
    result.status !== "edit" ||
    (statement.start === 0 && statement.end === request.text.length)
  ) {
    return result;
  }
  const leadingWhitespace = /^\s*/u.exec(statement.text)?.[0] ?? "";
  return {
    ...result,
    text: `${request.text.slice(0, statement.start)}${leadingWhitespace}${result.text.trimEnd()}${request.text.slice(statement.end)}`,
  };
}

function composePostgresStatement(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
): SqlAuthoringComposeResult {
  const payload = request.payload;
  if (payload.serverId !== snapshot.serverId || payload.database !== snapshot.database) {
    return {
      status: "rejected",
      message: "The dragged object belongs to another DatabaseContext.",
    };
  }
  if (snapshot.status === "stale") {
    return {
      status: "rejected",
      message: "The Workbench Index is stale. Reindex before composing SQL.",
    };
  }
  const queryShape = analyzeSqlQueryShape(request.text);
  if (queryShape.hasNestedQuery) {
    return {
      status: "rejected",
      message: "Composition does not modify CTEs or nested queries.",
    };
  }
  if (request.text.trim().length > 0 && !queryShape.supportsComposition) {
    return {
      status: "rejected",
      message:
        "Composition supports one top-level SELECT without set operations, WINDOW, FETCH, INTO, or locking clauses.",
    };
  }
  if (payload.kind === "column") return composeColumn(request, snapshot);
  const target = snapshot.objects.find(
    (object) => object.oid === payload.oid && object.kind === payload.kind,
  );
  if (!target) {
    return { status: "rejected", message: "The dragged PostgreSQL object is no longer indexed." };
  }
  if (request.text.trim().length === 0) {
    return {
      status: "edit",
      text: tableProjection(target),
      title: `Compose ${target.schema}.${target.name}`,
    };
  }
  return composeJoin(request, snapshot, target);
}

function composeColumn(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
): SqlAuthoringComposeResult {
  const payload = request.payload;
  if (payload.kind !== "column") throw new Error("Expected a column payload");
  const table = snapshot.objects.find(
    (object) => object.oid === payload.tableOid && object.kind === "table",
  );
  if (!table?.columns.some((column) => column.name === payload.name)) {
    return { status: "rejected", message: "The dragged PostgreSQL column is no longer indexed." };
  }
  const topLevelSource = scanPostgresSql(request.text).topLevelSource;
  const select = /\bSELECT\b([\s\S]*?)\bFROM\b/iu.exec(topLevelSource);
  if (!select || select.index === undefined) {
    return { status: "rejected", message: "Drop a column into a SELECT projection." };
  }
  const references = tableReferences(request.text, snapshot.objects);
  const reference = references.find(({ object }) => object.oid === table.oid);
  if (!reference) {
    return { status: "rejected", message: "The column's table is not part of this query." };
  }
  const expression = `${reference.reference}.${quoteIdentifier(payload.name)}`;
  if (select[1].split(",").some((part) => normalizeSql(part) === normalizeSql(expression))) {
    return { status: "rejected", message: "This column is already in the SELECT projection." };
  }
  const projectionStart = select.index + "SELECT".length;
  const fromOffset = projectionStart + select[1].length;
  const projection = request.text.slice(projectionStart, fromOffset);
  const separator = projection.trim().length === 0 ? " " : `${projection.replace(/\s+$/u, "")}, `;
  const updated = `${request.text.slice(0, select.index + "SELECT".length)}${separator}${expression} ${request.text.slice(fromOffset)}`;
  return {
    status: "edit",
    text: formatPostgresSql(updated),
    title: `Add ${payload.name} to SELECT`,
  };
}

function composeJoin(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
  target: SqlAuthoringObject,
): SqlAuthoringComposeResult {
  const references = tableReferences(request.text, snapshot.objects);
  if (references.length === 0) {
    return {
      status: "rejected",
      message: "Drop the table into a query with an indexed FROM relation.",
    };
  }
  if (references.some(({ object }) => object.oid === target.oid)) {
    return { status: "rejected", message: "This relation is already part of the query." };
  }
  const candidates = references.flatMap((reference) =>
    snapshot.foreignKeys.flatMap((foreignKey, index) =>
      connects(foreignKey, reference.object.oid, target.oid)
        ? [{ foreignKey, reference, index }]
        : [],
    ),
  );
  if (candidates.length === 0) {
    return {
      status: "rejected",
      message: "No reliable direct foreign key connects this relation to the query.",
    };
  }
  if (candidates.length > 1 && request.relationChoice === undefined) {
    return {
      status: "ambiguous",
      choices: candidates.map((candidate, index) => ({
        index,
        label: joinLabel(
          candidate.foreignKey,
          candidate.reference.object,
          target,
          snapshot.objects,
        ),
        description: `${candidate.reference.object.schema}.${candidate.reference.object.name} ↔ ${target.schema}.${target.name}`,
      })),
    };
  }
  const candidate = candidates[request.relationChoice ?? 0];
  if (!candidate)
    return { status: "rejected", message: "The selected foreign key is no longer available." };
  const targetReference = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`;
  const conditions = joinConditions(candidate.foreignKey, candidate.reference, targetReference);
  const joinKeyword = automaticJoinKeyword(candidate.foreignKey, candidate.reference.object);
  const join = ` ${joinKeyword} ${targetReference} ON ${conditions.join(" AND ")}`;
  const insertion = joinInsertionOffset(request.text);
  const updated = `${request.text.slice(0, insertion).trimEnd()}${join}${request.text.slice(insertion)}`;
  return {
    status: "edit",
    text: formatPostgresSql(updated),
    title: `Join ${target.schema}.${target.name}`,
  };
}

function tableProjection(object: SqlAuthoringObject): string {
  const columns = object.columns.map((column) => quoteIdentifier(column.name));
  const projection = columns.length > 0 ? columns.join(", ") : "*";
  return formatPostgresSql(
    `SELECT ${projection} FROM ${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)};`,
  );
}

interface TableReference {
  object: SqlAuthoringObject;
  reference: string;
}

function tableReferences(source: string, objects: readonly SqlAuthoringObject[]): TableReference[] {
  const references: TableReference[] = [];
  const topLevelSource = scanPostgresSql(source).topLevelSource;
  const pattern =
    /\b(?:FROM|JOIN)\s+((?:"(?:""|[^"])+"|[\w$]+)(?:\.(?:"(?:""|[^"])+"|[\w$]+))?)(?:\s+(?:AS\s+)?((?:"(?:""|[^"])+"|[\w$]+)))?/giu;
  for (const match of topLevelSource.matchAll(pattern)) {
    const relationOffset = (match.index ?? 0) + match[0].indexOf(match[1]);
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
    const aliasOffset = match[2] ? (match.index ?? 0) + match[0].lastIndexOf(match[2]) : undefined;
    const candidateAlias =
      aliasOffset === undefined
        ? undefined
        : source.slice(aliasOffset, aliasOffset + match[2].length);
    references.push({
      object,
      reference:
        candidateAlias &&
        (candidateAlias.startsWith('"') ||
          !CLAUSE_KEYWORDS.has(canonicalSqlIdentifier(candidateAlias)))
          ? candidateAlias
          : relation,
    });
  }
  return references;
}

function connects(foreignKey: SqlAuthoringForeignKey, leftOid: number, rightOid: number): boolean {
  return (
    (foreignKey.sourceTableOid === leftOid && foreignKey.targetTableOid === rightOid) ||
    (foreignKey.sourceTableOid === rightOid && foreignKey.targetTableOid === leftOid)
  );
}

function joinConditions(
  foreignKey: SqlAuthoringForeignKey,
  current: TableReference,
  targetReference: string,
): string[] {
  const currentIsSource = foreignKey.sourceTableOid === current.object.oid;
  const currentColumns = currentIsSource ? foreignKey.sourceColumns : foreignKey.targetColumns;
  const targetColumns = currentIsSource ? foreignKey.targetColumns : foreignKey.sourceColumns;
  return currentColumns.map(
    (column, index) =>
      `${current.reference}.${quoteIdentifier(column)} = ${targetReference}.${quoteIdentifier(targetColumns[index])}`,
  );
}

function automaticJoinKeyword(
  foreignKey: SqlAuthoringForeignKey,
  current: SqlAuthoringObject,
): "JOIN" | "LEFT JOIN" {
  if (foreignKey.sourceTableOid !== current.oid) return "LEFT JOIN";
  if (
    foreignKey.sourceColumnsNullable.length !== foreignKey.sourceColumns.length ||
    foreignKey.sourceColumnsNullable.some(Boolean)
  ) {
    return "LEFT JOIN";
  }
  return "JOIN";
}

function joinLabel(
  foreignKey: SqlAuthoringForeignKey,
  current: SqlAuthoringObject,
  target: SqlAuthoringObject,
  objects: readonly SqlAuthoringObject[],
): string {
  const source = objects.find((object) => object.oid === foreignKey.sourceTableOid);
  const destination = objects.find((object) => object.oid === foreignKey.targetTableOid);
  return `${automaticJoinKeyword(foreignKey, current)} via ${source?.name ?? current.name}(${foreignKey.sourceColumns.join(", ")}) → ${destination?.name ?? target.name}(${foreignKey.targetColumns.join(", ")})`;
}

function joinInsertionOffset(source: string): number {
  const boundary = /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b|;/iu.exec(
    scanPostgresSql(source).topLevelSource,
  );
  return boundary?.index ?? source.length;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, "").replaceAll('"', "").toLocaleLowerCase();
}
