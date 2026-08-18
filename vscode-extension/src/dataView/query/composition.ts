import type { SyntaxParser } from "../../../../src/analysis/syntaxTree.js";
import { composePostgresSql } from "../../sqlAuthoring/composition.js";
import { reachableJoinTargets, shortestJoinPlans } from "../../sqlAuthoring/joinPlanner.js";
import type {
  SqlAuthoringComposeRequest,
  SqlAuthoringComposeResult,
  SqlAuthoringDragPayload,
  SqlAuthoringSettings,
  SqlAuthoringSnapshot,
} from "../../sqlAuthoring/protocol.js";
import type { DataViewAddition, DataViewProjection } from "../protocol.js";
import { analyzeDataViewQuery, formatDataViewQuery } from "../queryAnalysis.js";

/**
 * Everything the composition engine can add to a query, grouped by table already present
 * (its columns not yet projected, the tables related through foreign keys), then every other
 * table and view of the database. `tableIndex` is -1 for the last group.
 */
export function dataViewAdditions(
  projection: DataViewProjection,
  projectedColumns: ReadonlySet<string>,
  snapshot: SqlAuthoringSnapshot,
): DataViewAddition[] {
  const items: DataViewAddition[] = [];
  const presentOids = projection.tables.map((table) => table.tableOid);
  const present = new Set(presentOids);
  const name = (oid: number) => snapshot.objects.find((object) => object.oid === oid)?.name ?? "?";
  projection.tables.forEach((table, tableIndex) => {
    const object = snapshot.objects.find((candidate) => candidate.oid === table.tableOid);
    if (!object) return;
    for (const column of object.columns) {
      if (projectedColumns.has(column.name)) continue;
      const payload: SqlAuthoringDragPayload = {
        kind: "column",
        serverId: object.serverId,
        database: object.database,
        tableOid: object.oid,
        tableSchema: object.schema,
        tableName: object.name,
        name: column.name,
      };
      items.push({ tableIndex, kind: "column", label: column.name, detail: column.type, payload });
    }
  });
  // Related tables: the same planner the JOIN composition uses, so what is offered is what
  // composes. Reached through a mapping table when there is no direct key.
  const relations = snapshot.objects.filter(
    (object) => (object.kind === "table" || object.kind === "view") && !present.has(object.oid),
  );
  const reachable = reachableJoinTargets(
    snapshot,
    presentOids,
    relations.map((object) => object.oid),
    { maxHops: 2 },
  );
  for (const object of relations) {
    const plans = reachable.get(object.oid);
    const shortest = plans?.[0];
    if (!shortest) continue;
    const alternatives = shortestJoinPlans(plans ?? []).length;
    const hop = shortest.hops[0];
    const detail =
      shortest.viaOids.length > 0
        ? `via ${shortest.viaOids.map(name).join(" → ")}`
        : hop
          ? hop.foreignKey.sourceTableOid === shortest.startOid
            ? `${hop.foreignKey.sourceColumns.join(", ")} → ${object.name}`
            : `${object.name}.${hop.foreignKey.sourceColumns.join(", ")} → ${name(shortest.startOid)}`
          : "";
    const more =
      alternatives > 1 ? ` (+${alternatives - 1} other path${alternatives > 2 ? "s" : ""})` : "";
    items.push({
      tableIndex: shortest.startIndex,
      kind: "table",
      label: `${object.schema}.${object.name}`,
      detail: `${detail}${more}`,
      payload: relationPayload(object),
    });
  }
  // Every other table and view of the database: composed as an independent SELECT is refused
  // for a Data View, so the engine will say why on selection.
  for (const object of relations) {
    if (reachable.has(object.oid)) continue;
    items.push({
      tableIndex: -1,
      kind: "table",
      label: `${object.schema}.${object.name}`,
      detail: object.kind,
      payload: relationPayload(object),
    });
  }
  return items;
}

function relationPayload(object: SqlAuthoringSnapshot["objects"][number]): SqlAuthoringDragPayload {
  return {
    kind: object.kind === "view" ? "view" : "table",
    serverId: object.serverId,
    database: object.database,
    oid: object.oid,
    schema: object.schema,
    name: object.name,
  };
}

export type CompositionOutcome =
  | { status: "changed"; text: string; title: string }
  | {
      status: "ambiguous";
      title: string;
      choices: Array<{ index: number; label: string; description: string }>;
    }
  | { status: "rejected"; message: string };

/**
 * Extends the query through the SQL authoring composition engine, exactly as a Scratchpad drop
 * does. When several JOIN paths exist the choices are returned for the caller's own picker;
 * `relationChoice` then selects one.
 */
export async function composeIntoDataViewQuery(options: {
  text: string;
  statementEnd: number;
  uri: string;
  payload: SqlAuthoringDragPayload;
  relationChoice?: number;
  snapshot: SqlAuthoringSnapshot;
  settings: SqlAuthoringSettings;
  parser: SyntaxParser;
}): Promise<CompositionOutcome> {
  const request: SqlAuthoringComposeRequest = {
    uri: options.uri,
    text: options.text,
    offset: options.statementEnd,
    payload: options.payload,
    ...(options.relationChoice === undefined ? {} : { relationChoice: options.relationChoice }),
  };
  const result: SqlAuthoringComposeResult = composePostgresSql(
    request,
    options.snapshot,
    options.settings,
  );
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      title: result.title ?? "Choose the JOIN path",
      choices: result.choices,
    };
  }
  if (result.status !== "edit") {
    return { status: "rejected", message: result.message };
  }
  const composed = await analyzeDataViewQuery(result.text, options.parser);
  if (composed.status !== "ok") {
    return {
      status: "rejected",
      message: `${result.title}: the composed SQL is not a single SELECT (${composed.message}). Nothing changed.`,
    };
  }
  return {
    status: "changed",
    text: formatDataViewQuery(result.text, options.settings.tabSize),
    title: result.title,
  };
}
