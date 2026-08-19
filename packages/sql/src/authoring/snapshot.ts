/**
 * The catalog snapshot SQL authoring works against: the objects of one database, the settings that
 * shape the SQL written from them, and the payload a Workbench object carries when dragged into an
 * editor. Independent of how the language server delivers it.
 */

export const SQL_AUTHORING_OBJECT_MIME = "application/vnd.postgresql-workbench.sql-object";

export type SqlAuthoringAliasStyle = "fullName" | "initial";

export interface SqlAuthoringSettings {
  aliasStyle: SqlAuthoringAliasStyle;
  syntaxMaxDepth: number;
  syntaxMaxNodes: number;
  tabSize: number;
}

export const DEFAULT_SQL_AUTHORING_SETTINGS: SqlAuthoringSettings = {
  aliasStyle: "fullName",
  syntaxMaxDepth: 1_024,
  syntaxMaxNodes: 100_000,
  tabSize: 2,
};

export interface SqlAuthoringDatabaseIdentity {
  serverId: string;
  database: string;
}

export interface SqlAuthoringColumn {
  name: string;
  type: string;
}

export type SqlAuthoringObjectKind = "table" | "view" | "function" | "procedure";

export interface SqlAuthoringObject {
  serverId: string;
  database: string;
  schema: string;
  oid: number;
  name: string;
  kind: SqlAuthoringObjectKind;
  signature: string;
  plpgsql?: boolean;
  returnType?: string;
  parameters: Array<{ name: string; type: string }>;
  columns: SqlAuthoringColumn[];
}

export interface SqlAuthoringTrigger {
  oid: number;
  schema: string;
  name: string;
  relationSchema: string;
  relationName: string;
  routineSchema: string;
  routineName: string;
  definition: string;
}

export interface SqlAuthoringForeignKey {
  sourceTableOid: number;
  targetTableOid: number;
  sourceColumns: string[];
  sourceColumnsNullable: boolean[];
  targetColumns: string[];
  validated: boolean;
}

export interface SqlAuthoringSnapshot extends SqlAuthoringDatabaseIdentity {
  status: "available" | "stale";
  revision: string;
  generation: number | null;
  objects: SqlAuthoringObject[];
  foreignKeys: SqlAuthoringForeignKey[];
  triggers?: SqlAuthoringTrigger[];
}

export interface SqlAuthoringSnapshotToken extends SqlAuthoringDatabaseIdentity {
  revision: string;
  generation: number | null;
}

export type SqlAuthoringDragPayload =
  | ({
      kind: "table" | "view" | "function" | "procedure" | "trigger";
      oid: number;
      schema: string;
      name: string;
    } & SqlAuthoringDatabaseIdentity)
  | ({
      kind: "column";
      tableOid: number;
      tableSchema: string;
      tableName: string;
      name: string;
    } & SqlAuthoringDatabaseIdentity);

export function serializeSqlAuthoringDrag(payload: SqlAuthoringDragPayload): string {
  return JSON.stringify(payload);
}

export function parseSqlAuthoringDrag(value: string): SqlAuthoringDragPayload | undefined {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof payload.serverId !== "string" ||
      typeof payload.database !== "string" ||
      typeof payload.name !== "string"
    ) {
      return undefined;
    }
    if (
      payload.kind === "table" ||
      payload.kind === "view" ||
      payload.kind === "function" ||
      payload.kind === "procedure" ||
      payload.kind === "trigger"
    ) {
      return typeof payload.oid === "number" && typeof payload.schema === "string"
        ? (payload as unknown as SqlAuthoringDragPayload)
        : undefined;
    }
    if (payload.kind === "column") {
      return typeof payload.tableOid === "number" &&
        typeof payload.tableSchema === "string" &&
        typeof payload.tableName === "string"
        ? (payload as unknown as SqlAuthoringDragPayload)
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function sqlAuthoringSnapshotToken(
  snapshot: SqlAuthoringSnapshot,
): SqlAuthoringSnapshotToken {
  return {
    serverId: snapshot.serverId,
    database: snapshot.database,
    revision: snapshot.revision,
    generation: snapshot.generation,
  };
}
