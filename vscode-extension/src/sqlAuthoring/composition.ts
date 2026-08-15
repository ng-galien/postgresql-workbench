import { quoteIdentifier } from "./completion.js";
import { formatPostgresSql } from "./format.js";
import {
  canonicalSqlIdentifier,
  splitSqlQualifiedIdentifier,
  sqlAliasAfterRelation,
} from "./identifiers.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
  SqlAuthoringForeignKey,
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
} from "./protocol.js";
import { analyzeSqlQueryShape } from "./queryShape.js";
import { scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

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
        "Composition supports one top-level SELECT without comma joins, set operations, WINDOW, FETCH, INTO, or locking clauses.",
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
    (object) =>
      object.oid === payload.tableOid && (object.kind === "table" || object.kind === "view"),
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
  const matchingReferences = references.filter(({ object }) => object.oid === table.oid);
  if (matchingReferences.length === 0) {
    return { status: "rejected", message: "The column's table is not part of this query." };
  }
  if (matchingReferences.length > 1) {
    return {
      status: "rejected",
      message: "The column's table appears more than once in this query.",
    };
  }
  const [reference] = matchingReferences;
  const expression = `${reference.reference}.${quoteIdentifier(payload.name)}`;
  const projectionStart = select.index + "SELECT".length;
  const fromOffset = projectionStart + select[1].length;
  const projection = request.text.slice(projectionStart, fromOffset);
  if (/^\s*DISTINCT\s+ON\b/iu.test(select[1])) {
    return {
      status: "rejected",
      message: "Composition does not modify SELECT DISTINCT ON projections.",
    };
  }
  const modifierLength = /^\s*(?:ALL|DISTINCT)\b\s*/iu.exec(select[1])?.[0].length ?? 0;
  if (
    originalTopLevelParts(projection.slice(modifierLength), select[1].slice(modifierLength)).some(
      (part) => sameProjectedColumn(part, expression),
    )
  ) {
    return { status: "rejected", message: "This column is already in the SELECT projection." };
  }
  const separator = projection.trim().length === 0 ? " " : `${projection.replace(/\s+$/u, "")}, `;
  const updated = `${request.text.slice(0, select.index + "SELECT".length)}${separator}${expression} ${request.text.slice(fromOffset)}`;
  return {
    status: "edit",
    text: formatPostgresSql(updated),
    title: `Add ${payload.name} to SELECT`,
  };
}

function originalTopLevelParts(source: string, topLevelSource: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < topLevelSource.length; index += 1) {
    if (topLevelSource[index] !== ",") continue;
    parts.push(source.slice(start, index));
    start = index + 1;
  }
  parts.push(source.slice(start));
  return parts;
}

function sameProjectedColumn(candidate: string, expected: string): boolean {
  const candidateParts = projectedColumnIdentifiers(candidate);
  const expectedParts = projectedColumnIdentifiers(expected);
  return (
    candidateParts !== undefined &&
    expectedParts !== undefined &&
    candidateParts.length === expectedParts.length &&
    candidateParts.every((part, index) => part === expectedParts[index])
  );
}

function projectedColumnIdentifiers(source: string): string[] | undefined {
  const identifier = String.raw`(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)`;
  const match = new RegExp(
    String.raw`^\s*(${identifier}(?:\s*\.\s*${identifier}){1,2})(?:\s+(?:AS\s+)?${identifier})?\s*$`,
    "iu",
  ).exec(source);
  if (!match) return undefined;
  return splitSqlQualifiedIdentifier(match[1]).map((part) => canonicalSqlIdentifier(part.trim()));
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
      isStructurallyReliableForeignKey(foreignKey) &&
      connects(foreignKey, reference.object.oid, target.oid)
        ? [{ foreignKey, reference, index }]
        : [],
    ),
  );
  if (candidates.length === 0) {
    return {
      status: "edit",
      text: appendIndependentProjection(request.text, target),
      title: `Compose ${target.schema}.${target.name} as another SELECT`,
    };
  }
  if (candidates.length > 1 && request.relationChoice === undefined) {
    return {
      status: "ambiguous",
      choices: candidates.map((candidate, index) => ({
        index,
        label: joinLabel(candidate.foreignKey, candidate.reference, target, snapshot.objects),
        description: `${candidate.reference.reference} (${candidate.reference.object.schema}.${candidate.reference.object.name}) ↔ ${target.schema}.${target.name}`,
      })),
    };
  }
  const candidate = candidates[request.relationChoice ?? 0];
  if (!candidate)
    return { status: "rejected", message: "The selected foreign key is no longer available." };
  const targetReference = joinTargetReference(target, references);
  const conditions = joinConditions(
    candidate.foreignKey,
    candidate.reference,
    targetReference.correlation,
  );
  const joinKeyword = automaticJoinKeyword(candidate.foreignKey, candidate.reference);
  const join = ` ${joinKeyword} ${targetReference.relation} ON ${conditions.join(" AND ")}`;
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

function appendIndependentProjection(source: string, object: SqlAuthoringObject): string {
  const statement = source.trimEnd();
  const terminated = scanPostgresSql(statement).statementSeparators.length > 0;
  const separator = terminated ? "" : "\n;";
  return `${statement}${separator}\n\n${tableProjection(object)}`;
}

interface TableReference {
  correlationName: string;
  nullExtended: boolean;
  object: SqlAuthoringObject;
  reference: string;
}

function tableReferences(source: string, objects: readonly SqlAuthoringObject[]): TableReference[] {
  const references: TableReference[] = [];
  const topLevelSource = scanPostgresSql(source).topLevelSource;
  const pattern =
    /\b(?:FROM|(?:NATURAL\s+)?(?:(LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|(?:INNER|CROSS)\s+)?JOIN)\s+((?:"(?:""|[^"])+"|[\w$]+)(?:\.(?:"(?:""|[^"])+"|[\w$]+))?)/giu;
  for (const match of topLevelSource.matchAll(pattern)) {
    const joinDirection = match[1]?.toUpperCase();
    if (joinDirection === "RIGHT" || joinDirection === "FULL") {
      for (const reference of references) reference.nullExtended = true;
    }
    const relationOffset = (match.index ?? 0) + match[0].indexOf(match[2]);
    const relation = source.slice(relationOffset, relationOffset + match[2].length);
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
    const usableAlias = sqlAliasAfterRelation(
      source,
      topLevelSource,
      relationOffset + match[2].length,
    );
    references.push({
      correlationName: canonicalSqlIdentifier(usableAlias ?? parts[1]),
      nullExtended: joinDirection === "LEFT" || joinDirection === "FULL",
      object,
      reference: usableAlias ?? relation,
    });
  }
  return references;
}

function joinTargetReference(
  target: SqlAuthoringObject,
  references: readonly TableReference[],
): { correlation: string; relation: string } {
  const relation = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`;
  const implicitCorrelationName = canonicalSqlIdentifier(quoteIdentifier(target.name));
  const occupied = new Set(references.map(({ correlationName }) => correlationName));
  if (!occupied.has(implicitCorrelationName)) return { correlation: relation, relation };

  const stem = target.name.replace(/[^\p{L}\p{N}_$]/gu, "_") || "relation";
  let suffix = 2;
  let alias = quoteIdentifier(`${stem}_${suffix}`);
  while (occupied.has(canonicalSqlIdentifier(alias))) {
    suffix += 1;
    alias = quoteIdentifier(`${stem}_${suffix}`);
  }
  return { correlation: alias, relation: `${relation} AS ${alias}` };
}

function connects(foreignKey: SqlAuthoringForeignKey, leftOid: number, rightOid: number): boolean {
  return (
    (foreignKey.sourceTableOid === leftOid && foreignKey.targetTableOid === rightOid) ||
    (foreignKey.sourceTableOid === rightOid && foreignKey.targetTableOid === leftOid)
  );
}

function isStructurallyReliableForeignKey(foreignKey: SqlAuthoringForeignKey): boolean {
  const sourceColumns = foreignKey.sourceColumns;
  const targetColumns = foreignKey.targetColumns;
  return (
    foreignKey.validated === true &&
    Array.isArray(sourceColumns) &&
    Array.isArray(targetColumns) &&
    sourceColumns.length > 0 &&
    sourceColumns.length === targetColumns.length &&
    sourceColumns.every((column) => typeof column === "string" && column.length > 0) &&
    targetColumns.every((column) => typeof column === "string" && column.length > 0)
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
  current: TableReference,
): "JOIN" | "LEFT JOIN" {
  if (current.nullExtended || foreignKey.sourceTableOid !== current.object.oid) return "LEFT JOIN";
  const nullability = foreignKey.sourceColumnsNullable;
  if (
    !Array.isArray(nullability) ||
    nullability.length !== foreignKey.sourceColumns.length ||
    nullability.some((nullable) => typeof nullable !== "boolean" || nullable)
  ) {
    return "LEFT JOIN";
  }
  return "JOIN";
}

function joinLabel(
  foreignKey: SqlAuthoringForeignKey,
  current: TableReference,
  target: SqlAuthoringObject,
  objects: readonly SqlAuthoringObject[],
): string {
  const source = objects.find((object) => object.oid === foreignKey.sourceTableOid);
  const destination = objects.find((object) => object.oid === foreignKey.targetTableOid);
  return `${automaticJoinKeyword(foreignKey, current)} from ${current.reference} via ${source?.name ?? current.object.name}(${foreignKey.sourceColumns.join(", ")}) → ${destination?.name ?? target.name}(${foreignKey.targetColumns.join(", ")})`;
}

function joinInsertionOffset(source: string): number {
  const boundary = /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b|;/iu.exec(
    scanPostgresSql(source).topLevelSource,
  );
  return boundary?.index ?? source.length;
}
