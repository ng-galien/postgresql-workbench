import type { Client } from "pg";
import type { CatalogTable } from "./editability.js";

const CATALOG_SQL = `
SELECT c.oid::int AS table_oid,
       n.nspname AS schema,
       c.relname AS name,
       c.relkind::text AS relkind,
       c.relhassubclass AS has_subclasses,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'attnum', a.attnum,
                  'name', a.attname,
                  'type', format_type(a.atttypid, a.atttypmod),
                  'identity', a.attidentity::text,
                  'generated', a.attgenerated::text,
                  'notNull', a.attnotnull,
                  'hasDefault', a.atthasdef) ORDER BY a.attnum)
         FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json) AS columns,
       COALESCE((
         SELECT json_agg(json_build_object('attnums', i.attnums, 'primary', i.indisprimary)
                         ORDER BY i.indisprimary DESC, i.indexrelid)
         FROM (
           SELECT x.indexrelid, x.indisprimary,
                  (SELECT array_agg(k::int ORDER BY ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS u(k, ord)) AS attnums
           FROM pg_index x
           WHERE x.indrelid = c.oid
             AND x.indisunique AND x.indisvalid AND x.indisready
             AND x.indpred IS NULL AND x.indexprs IS NULL
             AND 0 <> ALL (x.indkey::int2[])
         ) i), '[]'::json) AS unique_indexes,
       COALESCE((
         SELECT array_agg(DISTINCT k::int)
         FROM pg_constraint f, unnest(f.conkey) AS k
         WHERE f.conrelid = c.oid AND f.contype = 'f'), '{}'::int[]) AS fk_attnums,
       COALESCE((
         SELECT json_agg(DISTINCT jsonb_build_object(
                  'table', rn.nspname || '.' || rc.relname,
                  'onDelete', f.confdeltype::text))
         FROM pg_constraint f
         JOIN pg_class rc ON rc.oid = f.conrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE f.confrelid = c.oid AND f.contype = 'f'), '[]'::json) AS referenced_by
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = ANY ($1::oid[])`;

interface CatalogRow {
  table_oid: number;
  schema: string;
  name: string;
  relkind: string;
  has_subclasses: boolean;
  columns: Array<{
    attnum: number;
    name: string;
    type: string;
    identity: string;
    generated: string;
    notNull: boolean;
    hasDefault: boolean;
  }>;
  unique_indexes: Array<{ attnums: number[]; primary: boolean }>;
  fk_attnums: number[];
  referenced_by: Array<{ table: string; onDelete: string }>;
}

/** How PostgreSQL spells a delete rule in `pg_constraint.confdeltype`. */
const DELETE_RULES: Record<string, CatalogTable["referencedBy"][number]["onDelete"]> = {
  a: "no-action",
  r: "restrict",
  c: "cascade",
  n: "set-null",
  d: "set-default",
};

/** Loads the identity, relationship, and generation facts of the projected tables. */
export async function loadDataViewCatalog(
  client: Client,
  tableOids: readonly number[],
): Promise<CatalogTable[]> {
  const unique = [...new Set(tableOids.filter((oid) => oid > 0))];
  if (unique.length === 0) return [];
  const result = await client.query<CatalogRow>(CATALOG_SQL, [unique]);
  return result.rows.map((row) => ({
    tableOid: Number(row.table_oid),
    schema: row.schema,
    name: row.name,
    relkind: row.relkind,
    hasSubclasses: row.has_subclasses === true,
    columns: (row.columns ?? []).map((column) => ({
      attnum: Number(column.attnum),
      name: column.name,
      type: column.type,
      identity: column.identity === "a" || column.identity === "d" ? column.identity : "",
      generated: column.generated === "s" || column.generated === "v" ? column.generated : "",
      notNull: column.notNull === true,
      hasDefault: column.hasDefault === true,
    })),
    uniqueIndexes: (row.unique_indexes ?? []).map((index) => ({
      attnums: (index.attnums ?? []).map(Number),
      primary: index.primary === true,
    })),
    foreignKeyAttnums: (row.fk_attnums ?? []).map(Number),
    referencedBy: (row.referenced_by ?? []).map((reference) => ({
      table: reference.table,
      onDelete: DELETE_RULES[reference.onDelete] ?? "no-action",
    })),
  }));
}
