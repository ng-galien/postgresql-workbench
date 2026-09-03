import type { Client, FieldDef } from "pg";
import { types as pgTypes } from "pg";
import {
  type OffsetQueryOrder,
  type OffsetQueryTypes,
  OffsetResultSession,
  offsetPageSql,
  PostgresOffsetQuerySource,
  sameResultShape,
} from "../offsetQuery.js";
import type { ResultBinding } from "../resultPayload.js";
import { loadDataViewCatalog } from "./catalogFacts.js";
import {
  type DataViewEditability,
  type DataViewProjection,
  dataViewColumnKeys,
  dataViewKeysAt,
} from "./dataView.js";
import { type CatalogTable, resolveDataViewEditability } from "./editability.js";

/**
 * Data View pages keep every value as PostgreSQL text except booleans and binary values, so
 * edits and stale-row guards compare exactly what PostgreSQL stores.
 */
export const TEXT_PASSTHROUGH_TYPES: OffsetQueryTypes = {
  getTypeParser(oid, format) {
    if (format === "binary" || oid === 16 || oid === 17) {
      return pgTypes.getTypeParser(oid, format as never) as (value: string) => unknown;
    }
    return (value: string) => value;
  },
};

/** Stable palette index per table for the life of a view: colors never shift as tables come and go. */
export class TableAccents {
  private readonly byTable = new Map<number, number>();

  of(tableOid: number): number {
    let accent = this.byTable.get(tableOid);
    if (accent === undefined) {
      const used = new Set(this.byTable.values());
      accent = 0;
      while (used.has(accent)) accent += 1;
      this.byTable.set(tableOid, accent);
    }
    return accent;
  }
}

export interface OpenedDataViewResult {
  session: OffsetResultSession;
  editability: DataViewEditability;
  projection: DataViewProjection;
  /** Column keys of the projection, in ordinal order. */
  columnKeys: string[];
  /** Keys of identity and relationship columns: hidden by default the first time they appear. */
  technicalKeys: string[];
}

/** Settings shared by every LIMIT/OFFSET result. */
export interface DataViewResultSettings {
  pageSize: number;
  maxCellBytes: number;
}

export interface DataViewResultSort {
  direction: "ascending" | "descending";
  nulls?: "first" | "last";
  /** Projected output column resolved by the SQL query model. */
  column?: string;
}

/**
 * Keeps the reader's requested sort first, then completes it with every relation key. An empty
 * result means the projection does not prove a stable order and the original query is left alone.
 */
export function dataViewPageOrder(
  fields: readonly Pick<FieldDef, "name">[],
  editability: DataViewEditability,
  sourcesAreNamedRelations: boolean | undefined,
  relationCount: number | undefined,
  requested: readonly DataViewResultSort[],
): OffsetQueryOrder[] {
  if (
    sourcesAreNamedRelations !== true ||
    relationCount === undefined ||
    relationCount === 0 ||
    relationCount !== editability.tables.length
  ) {
    return [];
  }
  const order: OffsetQueryOrder[] = [];
  const orderedColumns = new Set<number>();
  for (const item of requested) {
    if (!item.column) return [];
    const matches = fields.flatMap((field, index) => (field.name === item.column ? [index] : []));
    if (matches.length !== 1) return [];
    const columnIndex = matches[0];
    if (columnIndex === undefined) return [];
    order.push({
      columnIndex,
      direction: item.direction,
      ...(item.nulls ? { nulls: item.nulls } : {}),
    });
    orderedColumns.add(columnIndex);
  }
  for (const table of editability.tables) {
    for (const columnIndex of table.keyOrdinals) {
      if (orderedColumns.has(columnIndex)) continue;
      order.push({ columnIndex, direction: "ascending" });
      orderedColumns.add(columnIndex);
    }
  }
  return order;
}

/** Whether each projected key belongs to a table whose own constraint covers every returned row. */
export function dataViewCatalogKeysCoverRows(
  editability: DataViewEditability,
  catalog: readonly Pick<CatalogTable, "tableOid" | "hasSubclasses">[],
): boolean {
  return editability.tables.every(
    (table) =>
      catalog.find((candidate) => candidate.tableOid === table.tableOid)?.hasSubclasses === false,
  );
}

/** Opens the shared LIMIT/OFFSET result; every page owns and releases its connection. */
export async function openOffsetResult(options: {
  openClient(): Promise<Client>;
  sql: string;
  settings: DataViewResultSettings;
  binding: ResultBinding;
  types?: OffsetQueryTypes;
  configure?: (client: Client) => Promise<void>;
}): Promise<OffsetResultSession> {
  const { openClient, sql, settings, binding, types, configure } = options;
  const source = new PostgresOffsetQuerySource(openClient, sql, {
    ...(types ? { types } : {}),
    ...(configure ? { configure } : {}),
  });
  return OffsetResultSession.open(source, {
    pageSize: settings.pageSize,
    maxRetainedCellBytes: settings.maxCellBytes,
    binding,
    statement: sql,
  });
}

/**
 * Probes the projection (RowDescription: table and column of every output), loads the catalog
 * facts of those tables, decides editability, then opens the shared LIMIT/OFFSET result.
 */
export async function openDataViewResult(options: {
  openClient(): Promise<Client>;
  sql: string;
  settings: DataViewResultSettings;
  binding: ResultBinding;
  accents: TableAccents;
  orderBy?: readonly DataViewResultSort[];
  /** Direct relations in the analyzed FROM clause; repeated relations count separately. */
  relationCount?: number;
  /** True only when the AST proves every FROM source is a named catalog relation. */
  sourcesAreNamedRelations?: boolean;
  /** Throws when the caller no longer wants this load; the client is then released. */
  checkpoint(): void;
  /** Gives the host an abort handle before opening either the probe or first-page connection. */
  registerCancellation(cancel: () => Promise<void>): void;
}): Promise<OpenedDataViewResult> {
  const {
    openClient,
    sql,
    settings,
    binding,
    accents,
    orderBy = [],
    relationCount,
    sourcesAreNamedRelations,
    checkpoint,
    registerCancellation,
  } = options;
  let cancelled = false;
  let client: Client | undefined;
  let source: PostgresOffsetQuerySource | undefined;
  let session: OffsetResultSession | undefined;
  registerCancellation(async () => {
    cancelled = true;
    const probeClient = client;
    client = undefined;
    await Promise.all([probeClient?.end().catch(() => {}), source?.cancel().catch(() => {})]);
  });
  const assertNotCancelled = () => {
    if (cancelled) throw new Error("Result loading cancelled.");
  };
  try {
    client = await openClient();
    if (cancelled) {
      await client.end().catch(() => {});
      client = undefined;
      throw new Error("Result loading cancelled.");
    }
    const probe = await client.query({
      text: offsetPageSql(sql, 0, 0),
      rowMode: "array",
    });
    assertNotCancelled();
    checkpoint();
    const catalog = await loadDataViewCatalog(
      client,
      probe.fields.map((field) => field.tableID),
    );
    assertNotCancelled();
    checkpoint();
    const editability = resolveDataViewEditability(probeFields(probe.fields), catalog);
    // Tables in order of first appearance in the projection, so badges follow the column order.
    const firstOrdinal = new Map<number, number>();
    probe.fields.forEach((field, ordinal) => {
      if (field.tableID > 0 && !firstOrdinal.has(field.tableID)) {
        firstOrdinal.set(field.tableID, ordinal);
      }
    });
    const tables = catalog
      .filter((table) => firstOrdinal.has(table.tableOid))
      .sort((a, b) => (firstOrdinal.get(a.tableOid) ?? 0) - (firstOrdinal.get(b.tableOid) ?? 0))
      .map((table) => ({
        tableOid: table.tableOid,
        schema: table.schema,
        name: table.name,
        accent: accents.of(table.tableOid),
      }));
    const projection: DataViewProjection = {
      tables,
      columnTable: probe.fields.map((field) => {
        const index = tables.findIndex((table) => table.tableOid === field.tableID);
        return index >= 0 ? index : undefined;
      }),
    };
    const columnNames = probe.fields.map((field) => field.name);
    // One derivation of the column keys, so hiding technical columns matches what the grid shows.
    const columnKeys = dataViewColumnKeys(projection, columnNames);
    const technicalKeys = dataViewKeysAt(columnKeys, editability.technicalOrdinals);
    const catalogKeysCoverRows = dataViewCatalogKeysCoverRows(editability, catalog);
    const pageOrder = dataViewPageOrder(
      probe.fields,
      editability,
      sourcesAreNamedRelations === true && catalogKeysCoverRows,
      relationCount,
      orderBy,
    );
    await client.end().catch(() => {});
    client = undefined;
    assertNotCancelled();
    checkpoint();
    source = new PostgresOffsetQuerySource(openClient, sql, {
      types: TEXT_PASSTHROUGH_TYPES,
      ...(pageOrder.length > 0 ? { orderBy: pageOrder } : {}),
    });
    session = await OffsetResultSession.open(source, {
      pageSize: settings.pageSize,
      maxRetainedCellBytes: settings.maxCellBytes,
      binding,
      statement: sql,
    });
    checkpoint();
    if (!sameResultShape(probe.fields, session.fieldDefinitions)) {
      throw new Error("The result shape changed while loading pages. Run the query again.");
    }
    return {
      session,
      editability,
      projection,
      columnKeys,
      technicalKeys,
    };
  } catch (error) {
    await client?.end().catch(() => {});
    await session?.close().catch(() => {});
    if (!session) await source?.cancel().catch(() => {});
    throw error;
  }
}

function probeFields(fields: readonly FieldDef[]) {
  return fields.map((field) => ({
    name: field.name,
    tableID: field.tableID,
    columnID: field.columnID,
    dataTypeID: field.dataTypeID,
  }));
}
