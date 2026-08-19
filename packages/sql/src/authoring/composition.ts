import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
} from "../languageServer/protocol.js";
import { quoteSqlIdentifierIfNeeded } from "./completion.js";
import { formatPostgresSql } from "./format.js";
import {
  canonicalSqlIdentifier,
  POSTGRES_IDENTIFIER_PATTERN,
  splitSqlQualifiedIdentifier,
} from "./identifiers.js";
import { type JoinPlan, planJoinPaths, shortestJoinPlans } from "./joinPlanner.js";
import type { SqlQueryAnalysis } from "./query/analysis.js";
import { relationsFromAnalysis, type TableReference } from "./query/relations.js";
import type { SqlQueryShape } from "./queryShape.js";
import type {
  SqlAuthoringForeignKey,
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
  SqlAuthoringTrigger,
} from "./snapshot.js";
import { DEFAULT_SQL_AUTHORING_SETTINGS, type SqlAuthoringSettings } from "./snapshot.js";
import { scanPostgresSql, sqlStatementAtOffset } from "./sqlLexing.js";

export function composePostgresSql(
  request: SqlAuthoringComposeRequest,
  snapshot: SqlAuthoringSnapshot,
  settings: SqlAuthoringSettings = DEFAULT_SQL_AUTHORING_SETTINGS,
  analysis?: SqlQueryAnalysis,
  shape?: SqlQueryShape,
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
    analysis,
    shape,
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
  analysis?: SqlQueryAnalysis,
  shape?: SqlQueryShape,
): SqlAuthoringComposeResult {
  const payload = request.payload;
  if (payload.serverId !== snapshot.serverId || payload.database !== snapshot.database) {
    return {
      status: "rejected",
      message: "The dragged object belongs to another Connexion.",
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
  const queryShape: SqlQueryShape = shape ?? { hasNestedQuery: false, supportsComposition: true };
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
  if (payload.kind === "column") return composeColumn(request, snapshot, settings, analysis);
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
  return composeJoin(request, snapshot, target, settings, analysis);
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
  const qualified = `${quoteSqlIdentifierIfNeeded(routine.schema)}.${quoteSqlIdentifierIfNeeded(routine.name)}`;
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
  const qualified = `${quoteSqlIdentifierIfNeeded(routine.schema)}.${quoteSqlIdentifierIfNeeded(routine.name)}`;
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
  const relationSql = `${quoteSqlIdentifierIfNeeded(relation.schema)}.${quoteSqlIdentifierIfNeeded(relation.name)}`;
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
            `${indent}${indent}${quoteSqlIdentifierIfNeeded(column.name)} = ${variableNames.get(column.name)}`,
        )
        .join(",\n");
      const predicate = idColumn
        ? `${quoteSqlIdentifierIfNeeded(idColumn.name)} = ${variableNames.get(idColumn.name)}`
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
        .map((column) => `${indent}${indent}${quoteSqlIdentifierIfNeeded(column.name)}`)
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
        ? `${quoteSqlIdentifierIfNeeded(idColumn.name)} = ${variableNames.get(idColumn.name)}`
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
    ? `${quoteSqlIdentifierIfNeeded(name)} => ${value}`
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
  return quoteSqlIdentifierIfNeeded(`v_${stem || `arg_${index + 1}`}`);
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
  analysis?: SqlQueryAnalysis,
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
  if (!analysis) {
    return { status: "rejected", message: "Drop a column into a SELECT projection." };
  }
  const references = relationsFromAnalysis(analysis, snapshot.objects);
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
  const expression = `${reference.reference}.${quoteSqlIdentifierIfNeeded(payload.name)}`;
  if (analysis.distinct?.on) {
    return {
      status: "rejected",
      message: "Composition does not modify SELECT DISTINCT ON projections.",
    };
  }
  if (analysis.targets.some((target) => sameProjectedColumn(target.text, expression))) {
    return { status: "rejected", message: "This column is already in the SELECT projection." };
  }
  const insertAt = analysis.targetList.end;
  const updated = `${request.text.slice(0, insertAt)}, ${expression}${request.text.slice(insertAt)}`;
  return {
    status: "edit",
    text: formatPostgresSql(updated, settings.tabSize),
    title: `Add ${payload.name} to SELECT`,
  };
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
  analysis?: SqlQueryAnalysis,
): SqlAuthoringComposeResult {
  const references = analysis ? relationsFromAnalysis(analysis, snapshot.objects) : [];
  if (!analysis || references.length === 0) {
    return {
      status: "rejected",
      message: "Drop the table into a query with an indexed FROM relation.",
    };
  }
  if (references.some(({ object }) => object.oid === target.oid)) {
    return { status: "rejected", message: "This relation is already part of the query." };
  }
  const plans = shortestJoinPlans(
    planJoinPaths(
      snapshot,
      references.map((reference) => reference.object.oid),
      target.oid,
    ),
  );
  if (plans.length === 0) {
    return {
      status: "edit",
      text: appendIndependentProjection(request.text, target, settings),
      title: `Compose ${target.schema}.${target.name} as another SELECT`,
    };
  }
  if (plans.length > 1 && request.relationChoice === undefined) {
    return {
      status: "ambiguous",
      choices: plans.map((plan, index) => ({
        index,
        label: joinPlanLabel(plan, references, snapshot.objects),
        description: joinPlanDescription(plan, references, snapshot.objects),
      })),
    };
  }
  const plan = plans[request.relationChoice ?? 0];
  if (!plan) {
    return { status: "rejected", message: "The selected foreign key is no longer available." };
  }
  const applied = applyJoinPlan(
    request.text,
    analysis,
    plan,
    references,
    snapshot.objects,
    settings,
  );
  if (!applied) {
    return { status: "rejected", message: "A relation of the JOIN path is no longer indexed." };
  }
  return {
    status: "edit",
    text: formatPostgresSql(applied, settings.tabSize),
    title:
      plan.viaOids.length === 0
        ? `Join ${target.schema}.${target.name}`
        : `Join ${target.schema}.${target.name} via ${plan.viaOids
            .map((oid) => snapshot.objects.find((object) => object.oid === oid)?.name ?? "?")
            .join(" → ")}`,
  };
}

/**
 * Appends one JOIN per hop of the plan (mapping tables included), aliasing each joined relation
 * so it never collides with the query, and projects the columns of the final target only.
 */
export function applyJoinPlan(
  text: string,
  analysis: SqlQueryAnalysis,
  plan: JoinPlan,
  references: readonly TableReference[],
  objects: readonly SqlAuthoringObject[],
  settings: SqlAuthoringSettings,
): string | undefined {
  const known: TableReference[] = [...references];
  let joins = "";
  let finalReference: TableReference | undefined;
  for (const hop of plan.hops) {
    // The first hop starts from the exact query reference the plan was computed for (a table
    // may appear several times, e.g. a self-join); later hops start from the relation just joined.
    const current = finalReference ?? references[plan.startIndex];
    const target = objects.find((object) => object.oid === hop.toOid);
    if (!current || !target) return undefined;
    const targetReference = joinTargetReference(target, known, settings.aliasStyle);
    const keyword = automaticJoinKeyword(hop.foreignKey, current);
    const conditions = joinConditions(hop.foreignKey, current, targetReference.correlation);
    joins += ` ${keyword} ${targetReference.relation} ON ${conditions.join(" AND ")}`;
    finalReference = {
      correlationName: canonicalSqlIdentifier(targetReference.correlation),
      nullExtended: current.nullExtended || keyword === "LEFT JOIN",
      object: target,
      reference: targetReference.correlation,
    };
    known.push(finalReference);
  }
  if (!finalReference) return undefined;
  // Both offsets come from the analysis of the original text, so the JOIN (later in the
  // statement) is inserted first and the projection offset stays valid.
  const joinAt = analysis.fromList?.end ?? analysis.fromEnd;
  const rest = text.slice(joinAt);
  // Keep a separator before a following clause (WHERE, ORDER BY…): "brand.idWHERE" is not SQL.
  const separator = rest.length > 0 && !/^\s/u.test(rest) ? "\n" : "";
  const joined = `${text.slice(0, joinAt).trimEnd()}${joins}${separator}${rest}`;
  const additions = joinedProjectionAdditions(
    analysis,
    finalReference.object,
    finalReference.reference,
  );
  if (additions === undefined) return joined;
  const insertAt = analysis.targetList.end;
  return `${joined.slice(0, insertAt)}, ${additions}${joined.slice(insertAt)}`;
}

/** `p.brand_id → brand.id`, or `p → product_category → category` for a path through mapping tables. */
export function joinPlanLabel(
  plan: JoinPlan,
  references: readonly TableReference[],
  objects: readonly SqlAuthoringObject[],
): string {
  const start = references[plan.startIndex];
  const name = (oid: number) => objects.find((object) => object.oid === oid)?.name ?? "?";
  const [first] = plan.hops;
  if (plan.hops.length === 1 && first && start) {
    const currentIsSource = first.foreignKey.sourceTableOid === start.object.oid;
    const currentColumns = currentIsSource
      ? first.foreignKey.sourceColumns
      : first.foreignKey.targetColumns;
    const targetColumns = currentIsSource
      ? first.foreignKey.targetColumns
      : first.foreignKey.sourceColumns;
    return `${start.reference}.${currentColumns.join(", ")} ${currentIsSource ? "→" : "←"} ${name(plan.targetOid)}.${targetColumns.join(", ")}`;
  }
  return [
    start?.reference ?? name(plan.startOid),
    ...plan.viaOids.map(name),
    name(plan.targetOid),
  ].join(" → ");
}

export function joinPlanDescription(
  plan: JoinPlan,
  references: readonly TableReference[],
  objects: readonly SqlAuthoringObject[],
): string {
  const start = references[plan.startIndex];
  const [first] = plan.hops;
  const keyword = first && start ? automaticJoinKeyword(first.foreignKey, start) : "JOIN";
  const label = (oid: number) => {
    const object = objects.find((candidate) => candidate.oid === oid);
    return object ? `${object.schema}.${object.name}` : "?";
  };
  const via = plan.viaOids.length > 0 ? ` via ${plan.viaOids.map(label).join(", ")}` : "";
  return `${keyword} · ${label(plan.startOid)} ↔ ${label(plan.targetOid)}${via}`;
}

/**
 * Columns of the joined relation to add to the projection, or nothing when the projection must
 * not be touched: `*`, DISTINCT, a grouped query, or a projection that calls functions.
 */
function joinedProjectionAdditions(
  analysis: SqlQueryAnalysis,
  target: SqlAuthoringObject,
  targetReference: string,
): string | undefined {
  if (target.columns.length === 0 || analysis.hasStar || analysis.distinct || analysis.grouped) {
    return undefined;
  }
  if (analysis.targets.some((projected) => projected.callsFunction)) return undefined;
  return target.columns
    .map((column) => `${targetReference}.${quoteSqlIdentifierIfNeeded(column.name)}`)
    .join(", ");
}

/** Explicit projection of every column of a relation, aliased per the authoring settings. */
export function tableProjection(
  object: SqlAuthoringObject,
  settings: SqlAuthoringSettings,
): string {
  const alias = generatedRelationAlias(object.name, settings.aliasStyle);
  const columns = object.columns.map(
    (column) => `${alias}.${quoteSqlIdentifierIfNeeded(column.name)}`,
  );
  const projection = columns.length > 0 ? columns.join(", ") : "*";
  return formatPostgresSql(
    `SELECT ${projection} FROM ${quoteSqlIdentifierIfNeeded(object.schema)}.${quoteSqlIdentifierIfNeeded(object.name)} AS ${alias};`,
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

function joinTargetReference(
  target: SqlAuthoringObject,
  references: readonly TableReference[],
  aliasStyle: SqlAuthoringSettings["aliasStyle"],
): { correlation: string; relation: string } {
  const relation = `${quoteSqlIdentifierIfNeeded(target.schema)}.${quoteSqlIdentifierIfNeeded(target.name)}`;
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
  return quoteSqlIdentifierIfNeeded(`${base}${suffix}`);
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
      `${current.reference}.${quoteSqlIdentifierIfNeeded(column)} = ${targetReference}.${quoteSqlIdentifierIfNeeded(targetColumns[index])}`,
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
