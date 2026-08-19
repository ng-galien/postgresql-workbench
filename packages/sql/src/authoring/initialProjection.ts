import type { DataViewSource } from "../../../views/src/dataView/protocol.js";
import { tableProjection } from "./composition.js";
import type { SqlAuthoringObject, SqlAuthoringSettings, SqlAuthoringSnapshot } from "./protocol.js";
import { stripStatementTerminator } from "./query/analysis.js";

/**
 * Initial query of a Data View: the user's statement for a SQL source; for a relation, the
 * explicit projection the composition engine writes (never `SELECT *`), from the Workbench
 * Index when available or from the given column names otherwise.
 */
export function initialDataViewQuery(
  source: DataViewSource,
  snapshot: SqlAuthoringSnapshot | undefined,
  settings: SqlAuthoringSettings,
  fallbackColumns: () => Promise<string[]>,
): Promise<string> {
  if (source.kind === "sql") return Promise.resolve(stripStatementTerminator(source.sql));
  const object = snapshot?.objects.find(
    (candidate) =>
      candidate.schema === source.schema &&
      candidate.name === source.name &&
      (candidate.kind === "table" || candidate.kind === "view"),
  );
  if (object && object.columns.length > 0) {
    return Promise.resolve(stripStatementTerminator(tableProjection(object, settings)));
  }
  return fallbackColumns().then((columns) => {
    const relation: SqlAuthoringObject = {
      serverId: source.serverId,
      database: source.database,
      schema: source.schema,
      oid: 0,
      name: source.name,
      kind: source.relationKind === "table" ? "table" : "view",
      signature: source.name,
      parameters: [],
      columns: columns.map((name) => ({ name, type: "" })),
    };
    return stripStatementTerminator(tableProjection(relation, settings));
  });
}
