import { quoteIdentifier } from "./completion.js";
import { formatPostgresSql } from "./format.js";
import {
  canonicalSqlIdentifier,
  POSTGRES_IDENTIFIER_PATTERN,
  splitSqlQualifiedIdentifier,
  sqlAliasAfterRelation,
} from "./identifiers.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
  SqlAuthoringForeignKey,
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
  SqlAuthoringTrigger,
} from "./protocol.js";
import { DEFAULT_SQL_AUTHORING_SETTINGS, type SqlAuthoringSettings } from "./protocol.js";
import { analyzeSqlQueryShape } from "./queryShape.js";
import { scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

export function composePostgresSql(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
  settings: SqlAuthoringSettings = DEFAULT_SQL_AUTHORING_SETTINGS,
): SqlAuthoringComposeResult {
  const statement = sqlStatementAtOffset(request.text, request.offset);
  const result = composePostgresStatement(
    {
      ...request,
      text: statement.text,
      offset: Math.max(0, request.offset - statement.start),
    },
    snapshot,
    settings,
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
  settings: SqlAuthoringSettings,
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
      reason: "stale",
    };
  }
  if (payload.kind === "trigger") {
    const trigger = (snapshot.triggers ?? []).find((candidate) => candidate.oid === payload.oid);
    if (!trigger) {
      return {
        status: "rejected",
        message: "The dragged PostgreSQL trigger is no longer indexed.",
      };
    }
    const routine = snapshot.objects.find(
      (object) =>
        object.kind === "function" &&
        object.schema === trigger.routineSchema &&
        object.name === trigger.routineName,
    );
    if (!routine) {
      return { status: "rejected", message: "The trigger function is no longer indexed." };
    }
    const harness = triggerFunctionBlock(routine, trigger, snapshot, settings.tabSize);
    if (!harness) {
      return {
        status: "rejected",
        message: `The ${trigger.schema}.${trigger.name} trigger shape cannot yet be generated safely.`,
      };
    }
    return {
      status: "edit",
      text: appendGeneratedStatement(request.text, harness),
      title: `Test ${trigger.schema}.${trigger.name}`,
    };
  }
  if (payload.kind === "function" || payload.kind === "procedure") {
    const routine = snapshot.objects.find(
      (object) => object.oid === payload.oid && object.kind === payload.kind,
    );
    if (!routine) {
      return {
        status: "rejected",
        message: "The dragged PostgreSQL routine is no longer indexed.",
      };
    }
    return composeRoutine(request, snapshot, routine, settings);
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
  if (payload.kind === "column") return composeColumn(request, snapshot, settings);
  const target = snapshot.objects.find(
    (object) => object.oid === payload.oid && object.kind === payload.kind,
  );
  if (!target) {
    return { status: "rejected", message: "The dragged PostgreSQL object is no longer indexed." };
  }
  if (request.text.trim().length === 0) {
    return {
      status: "edit",
      text: tableProjection(target, settings),
      title: `Compose ${target.schema}.${target.name}`,
    };
  }
  return composeJoin(request, snapshot, target, settings);
}

function composeRoutine(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
  routine: SqlAuthoringObject,
  settings: SqlAuthoringSettings,
): SqlAuthoringComposeResult {
  let generated: string;
  if (routine.kind === "procedure") {
    generated = procedureBlock(routine, settings.tabSize);
  } else if (routine.returnType?.toLocaleLowerCase() === "trigger") {
    const triggers = (snapshot.triggers ?? []).filter(
      (trigger) => trigger.routineSchema === routine.schema && trigger.routineName === routine.name,
    );
    if (triggers.length === 0) {
      return {
        status: "rejected",
        message:
          "This trigger function has no indexed trigger invocation. Reindex before generating its DML harness.",
      };
    }
    if (triggers.length > 1 && request.relationChoice === undefined) {
      return {
        status: "ambiguous",
        title: `Choose how to invoke ${routine.schema}.${routine.name}`,
        placeHolder: "Choose the trigger whose DML harness will be generated",
        choices: triggers.map((trigger, index) => ({
          index,
          label: `${trigger.schema}.${trigger.name}`,
          description: triggerSummary(trigger),
        })),
      };
    }
    const trigger = triggers[request.relationChoice ?? 0];
    if (!trigger) {
      return { status: "rejected", message: "The selected trigger is no longer indexed." };
    }
    const harness = triggerFunctionBlock(routine, trigger, snapshot, settings.tabSize);
    if (!harness) {
      return {
        status: "rejected",
        message: `The ${trigger.schema}.${trigger.name} trigger shape cannot yet be generated safely.`,
      };
    }
    generated = harness;
  } else if (routine.returnType?.toLocaleLowerCase() === "event_trigger") {
    return {
      status: "rejected",
      message: "Event trigger functions must be invoked by their associated DDL event.",
    };
  } else {
    generated = functionSelect(routine, settings.tabSize);
  }
  return {
    status: "edit",
    text: appendGeneratedStatement(request.text, generated),
    title: `Invoke ${routine.schema}.${routine.name}`,
  };
}

function functionSelect(routine: SqlAuthoringObject, tabSize: number): string {
  const indent = " ".repeat(tabSize);
  const qualified = `${quoteIdentifier(routine.schema)}.${quoteIdentifier(routine.name)}`;
  if (routine.parameters.length === 0) return `SELECT *\nFROM ${qualified}();\n`;
  const argumentsSql = routine.parameters
    .map((parameter, index) => {
      const value = `NULL::${parameter.type || "text"}`;
      return `${indent}${routineArgument(parameter.name, value, index)}`;
    })
    .join(",\n");
  return `SELECT *\nFROM ${qualified}(\n${argumentsSql}\n);\n`;
}

function procedureBlock(routine: SqlAuthoringObject, tabSize: number): string {
  const indent = " ".repeat(tabSize);
  const qualified = `${quoteIdentifier(routine.schema)}.${quoteIdentifier(routine.name)}`;
  const variables = routineVariableNames(routine.parameters);
  const declarations = routine.parameters
    .map((parameter, index) => `${indent}${variables[index]} ${parameter.type || "text"} := NULL;`)
    .join("\n");
  const argumentsSql = routine.parameters
    .map(
      (parameter, index) =>
        `${indent}${indent}${routineArgument(parameter.name, variables[index], index)}`,
    )
    .join(",\n");
  const call =
    routine.parameters.length === 0
      ? `${indent}CALL ${qualified}();`
      : `${indent}CALL ${qualified}(\n${argumentsSql}\n${indent});`;
  return [
    "DO $workbench$",
    ...(declarations ? ["DECLARE", declarations] : []),
    "BEGIN",
    call,
    "END",
    "$workbench$;",
    "",
  ].join("\n");
}

function triggerFunctionBlock(
  routine: SqlAuthoringObject,
  trigger: SqlAuthoringTrigger,
  snapshot: SqlAuthoringSnapshot,
  tabSize: number,
): string | undefined {
  const event = triggerEvent(trigger.definition);
  const relation = snapshot.objects.find(
    (object) =>
      object.schema === trigger.relationSchema &&
      object.name === trigger.relationName &&
      (object.kind === "table" || object.kind === "view"),
  );
  if (!event || !relation) return undefined;
  const indent = " ".repeat(tabSize);
  const relationSql = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`;
  const idColumn = relation.columns.find((column) => canonicalSqlIdentifier(column.name) === "id");
  const requestedColumns = event.columns
    .map((name) =>
      relation.columns.find(
        (column) => canonicalSqlIdentifier(column.name) === canonicalSqlIdentifier(name),
      ),
    )
    .filter((column): column is SqlAuthoringObject["columns"][number] => column !== undefined);
  const eventColumns =
    requestedColumns.length > 0 ? requestedColumns : relation.columns.slice(0, 1);
  const declaredColumns = [idColumn, ...eventColumns].filter(
    (column, index, columns): column is SqlAuthoringObject["columns"][number] =>
      column !== undefined &&
      columns.findIndex((candidate) => candidate?.name === column.name) === index,
  );
  const variableNames = new Map(
    declaredColumns.map((column, index) => [column.name, safeVariableName(column.name, index)]),
  );
  let declarations = declaredColumns
    .map((column) => `${indent}${variableNames.get(column.name)} ${column.type || "text"} := NULL;`)
    .join("\n");
  let statement: string;
  switch (event.kind) {
    case "UPDATE": {
      const assignments = eventColumns
        .map(
          (column) =>
            `${indent}${indent}${quoteIdentifier(column.name)} = ${variableNames.get(column.name)}`,
        )
        .join(",\n");
      const predicate = idColumn
        ? `${quoteIdentifier(idColumn.name)} = ${variableNames.get(idColumn.name)}`
        : "FALSE /* replace with the target row predicate */";
      statement = `${indent}UPDATE ${relationSql}\n${indent}SET\n${assignments}\n${indent}WHERE ${predicate};`;
      break;
    }
    case "INSERT": {
      const columns = relation.columns;
      if (columns.length === 0) return undefined;
      const insertVariables = routineVariableNames(
        columns.map((column) => ({ name: column.name, type: column.type })),
      );
      const insertDeclarations = columns
        .map((column, index) => `${indent}${insertVariables[index]} ${column.type} := NULL;`)
        .join("\n");
      const names = columns
        .map((column) => `${indent}${indent}${quoteIdentifier(column.name)}`)
        .join(",\n");
      const values = insertVariables.map((variable) => `${indent}${indent}${variable}`).join(",\n");
      declarations = insertDeclarations;
      statement = [
        `${indent}INSERT INTO ${relationSql} (`,
        names,
        `${indent})`,
        `${indent}VALUES (`,
        values,
        `${indent});`,
      ].join("\n");
      break;
    }
    case "DELETE": {
      const predicate = idColumn
        ? `${quoteIdentifier(idColumn.name)} = ${variableNames.get(idColumn.name)}`
        : "FALSE /* replace with the target row predicate */";
      statement = `${indent}DELETE FROM ${relationSql}\n${indent}WHERE ${predicate};`;
      break;
    }
    case "TRUNCATE":
      return [
        `-- Invokes trigger ${trigger.schema}.${trigger.name} and function ${routine.schema}.${routine.name}`,
        "DO $workbench$",
        "DECLARE",
        `${indent}v_execute boolean := FALSE;`,
        "BEGIN",
        `${indent}IF v_execute THEN`,
        `${indent}${indent}TRUNCATE ${relationSql};`,
        `${indent}END IF;`,
        "END",
        "$workbench$;",
        "",
      ].join("\n");
  }
  const nestedStatement = statement
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  return [
    `-- Invokes trigger ${trigger.schema}.${trigger.name} and function ${routine.schema}.${routine.name}`,
    "-- Set the values below. Keep v_rollback = TRUE for a non-persistent test run.",
    "DO $workbench$",
    "DECLARE",
    ...(declarations ? [declarations] : []),
    `${indent}v_rollback boolean := TRUE;`,
    "BEGIN",
    `${indent}BEGIN`,
    nestedStatement,
    `${indent}${indent}IF v_rollback THEN`,
    `${indent}${indent}${indent}RAISE EXCEPTION USING`,
    `${indent}${indent}${indent}${indent}ERRCODE = 'PW001',`,
    `${indent}${indent}${indent}${indent}MESSAGE = 'Workbench trigger test rollback';`,
    `${indent}${indent}END IF;`,
    `${indent}EXCEPTION`,
    `${indent}${indent}WHEN SQLSTATE 'PW001' THEN`,
    `${indent}${indent}${indent}RAISE NOTICE 'Workbench trigger test rolled back';`,
    `${indent}END;`,
    "END",
    "$workbench$;",
    "",
  ].join("\n");
}

function triggerEvent(
  definition: string,
): { kind: "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE"; columns: string[] } | undefined {
  const match =
    /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OF\s+(.+?))?\s+ON\b/iu.exec(
      definition,
    );
  if (!match) return undefined;
  const columns = match[2]
    ? [...match[2].matchAll(new RegExp(POSTGRES_IDENTIFIER_PATTERN, "gu"))].map(
        (column) => column[0],
      )
    : [];
  return { kind: match[1].toUpperCase() as "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE", columns };
}

function triggerSummary(trigger: SqlAuthoringTrigger): string {
  const event = triggerEvent(trigger.definition);
  return `${event?.kind ?? "DML"} · ${trigger.relationSchema}.${trigger.relationName}`;
}

function routineArgument(name: string, value: string, index: number): string {
  return /^[A-Za-z_][\w$]*$/u.test(name) && !name.startsWith("$")
    ? `${quoteIdentifier(name)} => ${value}`
    : value || `$${index + 1}`;
}

function routineVariableNames(parameters: readonly { name: string }[]): string[] {
  const occupied = new Set<string>();
  return parameters.map((parameter, index) => {
    let candidate = safeVariableName(parameter.name, index);
    let collision = 1;
    while (occupied.has(candidate)) {
      collision += 1;
      candidate = `${safeVariableName(parameter.name, index)}_${collision}`;
    }
    occupied.add(candidate);
    return candidate;
  });
}

function safeVariableName(name: string, index: number): string {
  const stem = name.replace(/^\$/u, "arg_").replace(/[^\p{L}\p{N}_$]/gu, "_");
  return quoteIdentifier(`v_${stem || `arg_${index + 1}`}`);
}

function appendGeneratedStatement(source: string, generated: string): string {
  const current = source.trimEnd();
  if (!current) return generated;
  const terminator = /;\s*$/u.test(current) ? "" : ";";
  return `${current}${terminator}\n\n${generated}`;
}

function composeColumn(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
  settings: SqlAuthoringSettings,
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
    text: formatPostgresSql(updated, settings.tabSize),
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
  settings: SqlAuthoringSettings,
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
      text: appendIndependentProjection(request.text, target, settings),
      title: `Compose ${target.schema}.${target.name} as another SELECT`,
    };
  }
  if (candidates.length > 1 && request.relationChoice === undefined) {
    return {
      status: "ambiguous",
      choices: candidates.map((candidate, index) => ({
        index,
        label: joinLabel(candidate.foreignKey, candidate.reference, target, snapshot.objects),
        description: `${automaticJoinKeyword(candidate.foreignKey, candidate.reference)} · ${candidate.reference.object.schema}.${candidate.reference.object.name} ↔ ${target.schema}.${target.name}`,
      })),
    };
  }
  const candidate = candidates[request.relationChoice ?? 0];
  if (!candidate)
    return { status: "rejected", message: "The selected foreign key is no longer available." };
  const targetReference = joinTargetReference(target, references, settings.aliasStyle);
  const conditions = joinConditions(
    candidate.foreignKey,
    candidate.reference,
    targetReference.correlation,
  );
  const joinKeyword = automaticJoinKeyword(candidate.foreignKey, candidate.reference);
  const join = ` ${joinKeyword} ${targetReference.relation} ON ${conditions.join(" AND ")}`;
  const projected = appendJoinedTableProjection(request.text, target, targetReference.correlation);
  const insertion = joinInsertionOffset(projected);
  const updated = `${projected.slice(0, insertion).trimEnd()}${join}${projected.slice(insertion)}`;
  return {
    status: "edit",
    text: formatPostgresSql(updated, settings.tabSize),
    title: `Join ${target.schema}.${target.name}`,
  };
}

function appendJoinedTableProjection(
  source: string,
  target: SqlAuthoringObject,
  targetReference: string,
): string {
  if (target.columns.length === 0) return source;
  const topLevelSource = scanPostgresSql(source).topLevelSource;
  const select = /\bSELECT\b([\s\S]*?)\bFROM\b/iu.exec(topLevelSource);
  if (!select || select.index === undefined || /^\s*\*\s*$/u.test(select[1])) return source;
  if (
    /^\s*(?:DISTINCT\b|ALL\b)/iu.test(select[1]) ||
    /\b(?:GROUP\s+BY|HAVING)\b/iu.test(topLevelSource) ||
    new RegExp(String.raw`${POSTGRES_IDENTIFIER_PATTERN}\s*\(`, "u").test(select[1])
  ) {
    return source;
  }
  const projectionStart = select.index + "SELECT".length;
  const fromOffset = projectionStart + select[1].length;
  const additions = target.columns
    .map((column) => `${targetReference}.${quoteIdentifier(column.name)}`)
    .join(", ");
  const existing = source.slice(0, fromOffset).replace(/\s+$/u, "");
  return `${existing}, ${additions} ${source.slice(fromOffset)}`;
}

function tableProjection(object: SqlAuthoringObject, settings: SqlAuthoringSettings): string {
  const alias = generatedRelationAlias(object.name, settings.aliasStyle);
  const columns = object.columns.map((column) => `${alias}.${quoteIdentifier(column.name)}`);
  const projection = columns.length > 0 ? columns.join(", ") : "*";
  return formatPostgresSql(
    `SELECT ${projection} FROM ${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)} AS ${alias};`,
    settings.tabSize,
  );
}

function appendIndependentProjection(
  source: string,
  object: SqlAuthoringObject,
  settings: SqlAuthoringSettings,
): string {
  const statement = source.trimEnd();
  const terminated = scanPostgresSql(statement).statementSeparators.length > 0;
  const separator = terminated ? "" : "\n;";
  return `${statement}${separator}\n\n${tableProjection(object, settings)}`;
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
      reference: usableAlias ?? parts[1],
    });
  }
  return references;
}

function joinTargetReference(
  target: SqlAuthoringObject,
  references: readonly TableReference[],
  aliasStyle: SqlAuthoringSettings["aliasStyle"],
): { correlation: string; relation: string } {
  const relation = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`;
  const occupied = new Set(references.map(({ correlationName }) => correlationName));
  let collisionIndex: number | undefined;
  let alias = generatedRelationAlias(target.name, aliasStyle);
  while (occupied.has(canonicalSqlIdentifier(alias))) {
    collisionIndex = (collisionIndex ?? 1) + 1;
    alias = generatedRelationAlias(target.name, aliasStyle, collisionIndex);
  }
  return { correlation: alias, relation: `${relation} AS ${alias}` };
}

function generatedRelationAlias(
  name: string,
  aliasStyle: SqlAuthoringSettings["aliasStyle"],
  collisionIndex?: number,
): string {
  const stem = name.replace(/[^\p{L}\p{N}_$]/gu, "_") || "relation";
  const base = aliasStyle === "initial" ? ([...stem][0] ?? "r") : stem;
  const suffix =
    collisionIndex === undefined
      ? ""
      : aliasStyle === "initial"
        ? collisionIndex
        : `_${collisionIndex}`;
  return quoteIdentifier(`${base}${suffix}`);
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
  _objects: readonly SqlAuthoringObject[],
): string {
  const currentIsSource = foreignKey.sourceTableOid === current.object.oid;
  const currentColumns = currentIsSource ? foreignKey.sourceColumns : foreignKey.targetColumns;
  const targetColumns = currentIsSource ? foreignKey.targetColumns : foreignKey.sourceColumns;
  const arrow = currentIsSource ? "→" : "←";
  return `${current.reference}.${currentColumns.join(", ")} ${arrow} ${target.name}.${targetColumns.join(", ")}`;
}

function joinInsertionOffset(source: string): number {
  const boundary = /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b|;/iu.exec(
    scanPostgresSql(source).topLevelSource,
  );
  return boundary?.index ?? source.length;
}
