import type { Client, FieldDef } from "pg";
import { types as pgTypes } from "pg";
import {
  type DataViewEditability,
  type DataViewProjection,
  dataViewColumnKeys,
} from "../../../../packages/views/src/dataView/protocol.js";
import type { NotebookBindingSnapshot } from "../../scratchpad/index.js";
import {
  PostgresCursorReader,
  postgresCursorSafetyTimeoutMs,
  type SqlCursorTypes,
  SqlResultSession,
} from "../../scratchpad/index.js";
import { loadDataViewCatalog } from "../dataViewCatalog.js";
import { READ_ONLY_REASONS, resolveDataViewEditability } from "../editability.js";
import type { DataViewResultSettings } from "../hostServices.js";

/**
 * Data View cursors keep every value as PostgreSQL text except booleans and binary values, so
 * edits and stale-row guards compare exactly what PostgreSQL stores.
 */
export const TEXT_PASSTHROUGH_TYPES: SqlCursorTypes = {
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
  session: SqlResultSession;
  editability: DataViewEditability;
  projection: DataViewProjection;
  /** Column keys of the projection, in ordinal order. */
  columnKeys: string[];
  /** Keys of identity and relationship columns: hidden by default the first time they appear. */
  technicalKeys: string[];
  idleTimeoutMs: number;
}

/**
 * Probes the projection (RowDescription: table and column of every output), loads the catalog
 * facts of those tables, decides editability, then opens the bounded cursor. The client is
 * owned by the returned session and closed with it; on failure it is closed here.
 */
export async function openDataViewResult(options: {
  client: Client;
  sql: string;
  settings: DataViewResultSettings;
  binding: NotebookBindingSnapshot;
  accents: TableAccents;
  /** Throws when the caller no longer wants this load; the client is then released. */
  checkpoint(): void;
}): Promise<OpenedDataViewResult> {
  const { client, sql, settings, binding, accents, checkpoint } = options;
  let reader: PostgresCursorReader | undefined;
  try {
    const idleTimeoutMs = settings.cursorIdleTimeoutSeconds * 1_000;
    await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
      `${postgresCursorSafetyTimeoutMs(idleTimeoutMs)}ms`,
    ]);
    const probe = await client.query({
      text: `SELECT * FROM (\n${sql}\n) AS "data_view_probe" LIMIT 0`,
      rowMode: "array",
    });
    checkpoint();
    const catalog = await loadDataViewCatalog(
      client,
      probe.fields.map((field) => field.tableID),
    );
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
    const technicalKeys = columnKeys.filter((_key, ordinal) => {
      const policy = editability.columns[ordinal];
      return (
        policy !== undefined &&
        !policy.editable &&
        (policy.reason === READ_ONLY_REASONS.identity ||
          policy.reason === READ_ONLY_REASONS.relationship)
      );
    });
    reader = new PostgresCursorReader(client, sql, { types: TEXT_PASSTHROUGH_TYPES });
    const session = await SqlResultSession.open(reader, {
      pageSize: settings.pageSize,
      maxCachedRows: settings.maxCachedRows,
      binding,
      statement: sql,
    });
    checkpoint();
    return {
      session,
      editability,
      projection,
      columnKeys,
      technicalKeys,
      idleTimeoutMs,
    };
  } catch (error) {
    if (reader) await reader.close().catch(() => {});
    else await client.end().catch(() => {});
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
