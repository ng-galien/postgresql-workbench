import { createHash } from "node:crypto";
import { quoteSqlIdentifier } from "../../sql/src/text/identifiers.js";

export interface CatalogQueryClient {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresCatalogIdentity {
  connectionId: string;
  database: string;
}

export interface VirtualSqlDocument {
  uri: string;
  language: "sql";
  content: string;
  postgres?: PostgresDocumentDescriptor;
}

export interface PostgresDocumentDescriptor extends PostgresCatalogIdentity {
  schema: string;
  documentKind: "schema" | "table" | "view" | "routine" | "trigger";
  oid: number;
  name: string;
  signature: string;
}

export interface VirtualSqlSourceSet {
  srcset: string;
  revision: string;
  documents: VirtualSqlDocument[];
}

export interface PostgresCatalogMetrics {
  introspectionMs: number;
  materializationMs: number;
  documentCount: number;
}

export interface PostgresCatalogSnapshot {
  sourceSet: VirtualSqlSourceSet;
  metrics: PostgresCatalogMetrics;
  origins: Map<string, PostgresCatalogObjectOrigin>;
  foreignKeys: PostgresForeignKey[];
  viewDependencies: PostgresViewDependency[];
}

export interface PostgresCatalogPatch {
  upsertDocuments: VirtualSqlDocument[];
  removeDocumentUris: string[];
  origins: Map<string, PostgresCatalogObjectOrigin>;
  affectedRelationOids: number[];
  foreignKeys: PostgresForeignKey[];
  viewDependencies: PostgresViewDependency[];
  introspectionMs: number;
  materializationMs: number;
}

export interface PostgresCatalogResourceSelector {
  kind: PostgresDocumentDescriptor["documentKind"] | "relation" | "constraint";
  oid: number;
}

export class PostgresCatalogFullRefreshRequired extends Error {}

export interface PostgresForeignKey {
  sourceTableOid: number;
  targetTableOid: number;
  sourceColumns: string[];
  sourceColumnsNullable: boolean[];
  targetColumns: string[];
  validated: boolean;
}

export interface PostgresViewDependency {
  sourceViewOid: number;
  targetRelationOid: number;
}

export function mergePostgresCatalogRelations(
  foreignKeys: readonly PostgresForeignKey[],
  viewDependencies: readonly PostgresViewDependency[],
  patch: Pick<PostgresCatalogPatch, "affectedRelationOids" | "foreignKeys" | "viewDependencies">,
): { foreignKeys: PostgresForeignKey[]; viewDependencies: PostgresViewDependency[] } {
  const affected = new Set(patch.affectedRelationOids);
  return {
    foreignKeys: foreignKeys
      .filter(
        (foreignKey) =>
          !affected.has(foreignKey.sourceTableOid) && !affected.has(foreignKey.targetTableOid),
      )
      .concat(patch.foreignKeys),
    viewDependencies: viewDependencies
      .filter(
        (dependency) =>
          !affected.has(dependency.sourceViewOid) && !affected.has(dependency.targetRelationOid),
      )
      .concat(patch.viewDependencies),
  };
}

export type PostgresCatalogObjectOrigin =
  | { kind: "database" }
  | { kind: "extension"; extension: string };

interface SchemaRow {
  oid: string;
  schemaName: string;
}

interface TableRow {
  tableOid: string;
  schemaName: string;
  tableName: string;
  extensionName?: string;
}

interface TableColumnRow extends TableRow {
  columnNumber: number;
  columnName: string;
  dataType: string;
  notNull: boolean;
  defaultExpression?: string;
  identityKind: string;
  generatedKind: string;
}

interface ConstraintRow {
  tableOid: string;
  constraintOid: string;
  constraintName: string;
  definition: string;
  referencedTableOid?: string;
  sourceColumns: string[];
  sourceColumnsNullable: boolean[];
  referencedColumns: string[];
  validated: boolean;
}

interface ViewDependencyRow {
  sourceViewOid: string;
  targetRelationOid: string;
}

interface DefinitionRow {
  oid: string;
  schemaName: string;
  objectName: string;
  definition: string;
  extensionName?: string;
  identityArguments: string;
  relationName?: string;
}

interface TableDefinition {
  oid: string;
  schemaName: string;
  tableName: string;
  columns: TableColumnRow[];
  constraints: ConstraintRow[];
}

interface CatalogDefinitionRows {
  schemas: SchemaRow[];
  tables: TableRow[];
  columns: TableColumnRow[];
  constraints: ConstraintRow[];
  views: DefinitionRow[];
  routines: DefinitionRow[];
  triggers: DefinitionRow[];
  viewDependencies: ViewDependencyRow[];
}

const USER_SCHEMA_FILTER = `
  namespace.nspname <> 'information_schema'
  AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
`;

const SCHEMAS_SQL = `
/* workbench:schemas */
SELECT
  namespace.oid::text AS oid,
  namespace.nspname AS schema_name
FROM pg_catalog.pg_namespace AS namespace
WHERE ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, namespace.oid
`;

const TABLES_SQL = `
/* workbench:tables */
SELECT
  relation.oid::text AS table_oid,
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  extension_row.extname AS extension_name
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_depend AS extension_dependency
  ON extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
  AND extension_dependency.objid = relation.oid
  AND extension_dependency.objsubid = 0
  AND extension_dependency.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension AS extension_row
  ON extension_row.oid = extension_dependency.refobjid
WHERE relation.relkind IN ('r', 'p')
  AND ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, relation.relname, relation.oid
`;

const COLUMNS_SQL = `
/* workbench:columns */
SELECT
  relation.oid::text AS table_oid,
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  extension_row.extname AS extension_name,
  attribute.attnum AS column_number,
  attribute.attname AS column_name,
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
  attribute.attnotnull AS not_null,
  pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expr,
  attribute.attidentity::text AS identity_kind,
  attribute.attgenerated::text AS generated_kind
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute AS attribute
  ON attribute.attrelid = relation.oid
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
LEFT JOIN pg_catalog.pg_attrdef AS default_value
  ON default_value.adrelid = relation.oid
  AND default_value.adnum = attribute.attnum
LEFT JOIN pg_catalog.pg_depend AS extension_dependency
  ON extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
  AND extension_dependency.objid = relation.oid
  AND extension_dependency.objsubid = 0
  AND extension_dependency.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension AS extension_row
  ON extension_row.oid = extension_dependency.refobjid
WHERE relation.relkind IN ('r', 'p')
  AND ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, relation.relname, relation.oid, attribute.attnum
`;

const CONSTRAINTS_SQL = `
/* workbench:constraints */
SELECT
  constraint_row.conrelid::text AS table_oid,
  constraint_row.oid::text AS constraint_oid,
  constraint_row.conname AS constraint_name,
  pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition,
  constraint_row.convalidated AS validated,
  CASE WHEN constraint_row.contype = 'f' THEN constraint_row.confrelid::text END AS referenced_table_oid,
  CASE WHEN constraint_row.contype = 'f' THEN (
    SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
    FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
      AND attribute.attnum = key_column.attnum
  ) END AS source_columns,
  CASE WHEN constraint_row.contype = 'f' THEN (
    SELECT pg_catalog.jsonb_agg(NOT attribute.attnotnull ORDER BY key_column.ordinality)
    FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
      AND attribute.attnum = key_column.attnum
  ) END AS source_columns_nullable,
  CASE WHEN constraint_row.contype = 'f' THEN (
    SELECT pg_catalog.jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
    FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.confrelid
      AND attribute.attnum = key_column.attnum
  ) END AS referenced_columns
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE constraint_row.contype IN ('c', 'f', 'p', 'u', 'x')
  AND ${USER_SCHEMA_FILTER}
ORDER BY constraint_row.conrelid, constraint_row.oid
`;

const VIEWS_SQL = `
/* workbench:views */
SELECT
  relation.oid::text AS oid,
  namespace.nspname AS schema_name,
  relation.relname AS object_name,
  pg_catalog.pg_get_viewdef(relation.oid, true) AS definition,
  extension_row.extname AS extension_name
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_depend AS extension_dependency
  ON extension_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
  AND extension_dependency.objid = relation.oid
  AND extension_dependency.objsubid = 0
  AND extension_dependency.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension AS extension_row
  ON extension_row.oid = extension_dependency.refobjid
WHERE relation.relkind = 'v'
  AND ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, relation.relname, relation.oid
`;

const VIEW_DEPENDENCIES_SQL = `
/* workbench:view-dependencies */
SELECT DISTINCT
  view_relation.oid::text AS source_view_oid,
  target_relation.oid::text AS target_relation_oid
FROM pg_catalog.pg_rewrite AS rewrite_rule
JOIN pg_catalog.pg_class AS view_relation
  ON view_relation.oid = rewrite_rule.ev_class
JOIN pg_catalog.pg_namespace AS view_namespace
  ON view_namespace.oid = view_relation.relnamespace
JOIN pg_catalog.pg_depend AS dependency
  ON dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
  AND dependency.objid = rewrite_rule.oid
  AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
JOIN pg_catalog.pg_class AS target_relation
  ON target_relation.oid = dependency.refobjid
JOIN pg_catalog.pg_namespace AS target_namespace
  ON target_namespace.oid = target_relation.relnamespace
WHERE view_relation.relkind = 'v'
  AND target_relation.relkind IN ('r', 'p', 'v')
  AND target_relation.oid <> view_relation.oid
  AND ${USER_SCHEMA_FILTER.replaceAll("namespace.", "view_namespace.")}
  AND ${USER_SCHEMA_FILTER.replaceAll("namespace.", "target_namespace.")}
ORDER BY source_view_oid, target_relation_oid
`;

const ROUTINES_SQL = `
/* workbench:routines */
SELECT
  routine.oid::text AS oid,
  namespace.nspname AS schema_name,
  routine.proname AS object_name,
  pg_catalog.pg_get_function_identity_arguments(routine.oid) AS identity_arguments,
  pg_catalog.pg_get_functiondef(routine.oid) AS definition,
  extension_row.extname AS extension_name
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = routine.pronamespace
LEFT JOIN pg_catalog.pg_depend AS extension_dependency
  ON extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
  AND extension_dependency.objid = routine.oid
  AND extension_dependency.objsubid = 0
  AND extension_dependency.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension AS extension_row
  ON extension_row.oid = extension_dependency.refobjid
WHERE routine.prokind IN ('f', 'p')
  AND ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, routine.proname, routine.oid
`;

const TRIGGERS_SQL = `
/* workbench:triggers */
SELECT
  trigger_row.oid::text AS oid,
  namespace.nspname AS schema_name,
  trigger_row.tgname AS object_name,
  relation.relname AS relation_name,
  pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition,
  extension_row.extname AS extension_name
FROM pg_catalog.pg_trigger AS trigger_row
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = trigger_row.tgrelid
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_depend AS extension_dependency
  ON extension_dependency.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
  AND extension_dependency.objid = trigger_row.oid
  AND extension_dependency.objsubid = 0
  AND extension_dependency.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension AS extension_row
  ON extension_row.oid = extension_dependency.refobjid
WHERE NOT trigger_row.tgisinternal
  AND ${USER_SCHEMA_FILTER}
ORDER BY namespace.nspname, trigger_row.tgname, trigger_row.oid
`;

// This static catalog assembler keeps the eight independently testable SQL fragments explicit;
// wrapping its sole call site in an options object would add indirection without a domain concept.
// code-moniker: ignore[code-single-responsibility-flags-long-parameter-lists]
function catalogSql(
  schemasSql: string,
  tablesSql: string,
  columnsSql: string,
  constraintsSql: string,
  viewsSql: string,
  viewDependenciesSql: string,
  routinesSql: string,
  triggersSql: string,
  marker = "workbench:catalog",
): string {
  return `
/* ${marker} */
WITH
schema_rows AS (${schemasSql}),
table_rows AS (${tablesSql}),
column_rows AS (${columnsSql}),
constraint_rows AS (${constraintsSql}),
view_rows AS (${viewsSql}),
view_dependency_rows AS (${viewDependenciesSql}),
routine_rows AS (${routinesSql}),
trigger_rows AS (${triggersSql})
SELECT
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(schema_row)) FROM schema_rows AS schema_row),
    '[]'::jsonb
  ) AS schemas,
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(table_row)) FROM table_rows AS table_row),
    '[]'::jsonb
  ) AS tables,
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(column_row)) FROM column_rows AS column_row),
    '[]'::jsonb
  ) AS columns,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(constraint_row))
      FROM constraint_rows AS constraint_row
    ),
    '[]'::jsonb
  ) AS constraints,
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(view_row)) FROM view_rows AS view_row),
    '[]'::jsonb
  ) AS views,
  COALESCE(
    (
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(view_dependency_row))
      FROM view_dependency_rows AS view_dependency_row
    ),
    '[]'::jsonb
  ) AS view_dependencies,
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(routine_row)) FROM routine_rows AS routine_row),
    '[]'::jsonb
  ) AS routines,
  COALESCE(
    (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(trigger_row)) FROM trigger_rows AS trigger_row),
    '[]'::jsonb
  ) AS triggers
`;
}

const CATALOG_SQL = catalogSql(
  SCHEMAS_SQL,
  TABLES_SQL,
  COLUMNS_SQL,
  CONSTRAINTS_SQL,
  VIEWS_SQL,
  VIEW_DEPENDENCIES_SQL,
  ROUTINES_SQL,
  TRIGGERS_SQL,
);

export async function readPostgresCatalog(
  client: CatalogQueryClient,
  identity: PostgresCatalogIdentity,
): Promise<PostgresCatalogSnapshot> {
  const introspectionStarted = performance.now();
  const catalogRows = (await client.query(CATALOG_SQL)).rows;
  if (catalogRows.length !== 1) {
    throw new Error("PostgreSQL catalog snapshot returned an invalid result");
  }
  const definitions = catalogDefinitions(catalogRows[0]);
  const introspectionMs = performance.now() - introspectionStarted;

  const materializationStarted = performance.now();
  const documents = buildDocuments(identity, definitions);
  const origins = catalogOrigins(identity, definitions);
  const revision = sourceSetRevision(documents, origins);

  return {
    sourceSet: {
      srcset: postgresSourceSetName(identity),
      revision,
      documents,
    },
    metrics: {
      introspectionMs,
      materializationMs: performance.now() - materializationStarted,
      documentCount: documents.length,
    },
    origins,
    foreignKeys: definitions.constraints.flatMap((constraint) =>
      constraint.referencedTableOid
        ? [
            {
              sourceTableOid: Number(constraint.tableOid),
              targetTableOid: Number(constraint.referencedTableOid),
              sourceColumns: constraint.sourceColumns,
              sourceColumnsNullable: constraint.sourceColumnsNullable,
              targetColumns: constraint.referencedColumns,
              validated: constraint.validated,
            },
          ]
        : [],
    ),
    viewDependencies: definitions.viewDependencies.map((dependency) => ({
      sourceViewOid: Number(dependency.sourceViewOid),
      targetRelationOid: Number(dependency.targetRelationOid),
    })),
  };
}

/**
 * Reprojects exactly the requested virtual PostgreSQL documents. Dependency
 * selection belongs to the caller (the Code Moniker usage graph); this query
 * deliberately performs no transitive PostgreSQL expansion.
 */
export async function readPostgresCatalogDocuments(
  client: CatalogQueryClient,
  identity: PostgresCatalogIdentity,
  existingDocuments: readonly VirtualSqlDocument[],
  documentUris: ReadonlySet<string>,
  newResources: readonly PostgresCatalogResourceSelector[] = [],
): Promise<PostgresCatalogPatch> {
  const requested = existingDocuments.filter((document) => documentUris.has(document.uri));
  if (requested.length !== documentUris.size || requested.some((document) => !document.postgres)) {
    throw new PostgresCatalogFullRefreshRequired(
      "a requested PostgreSQL source document has no local resource mapping",
    );
  }

  const ids: IncrementalCatalogIds = {
    relationIds: [],
    routineIds: [],
    triggerIds: [],
    constraintIds: [],
    schemaIds: [],
  };
  for (const document of requested) {
    const postgres = document.postgres!;
    switch (postgres.documentKind) {
      case "table":
      case "view":
        ids.relationIds.push(postgres.oid);
        break;
      case "routine":
        ids.routineIds.push(postgres.oid);
        break;
      case "trigger":
        ids.triggerIds.push(postgres.oid);
        break;
      case "schema":
        ids.schemaIds.push(postgres.oid);
        break;
    }
  }
  for (const resource of newResources) {
    switch (resource.kind) {
      case "table":
      case "view":
      case "relation":
        ids.relationIds.push(resource.oid);
        break;
      case "routine":
        ids.routineIds.push(resource.oid);
        break;
      case "trigger":
        ids.triggerIds.push(resource.oid);
        break;
      case "schema":
        ids.schemaIds.push(resource.oid);
        break;
      case "constraint":
        ids.constraintIds.push(resource.oid);
        break;
    }
  }

  const introspectionStarted = performance.now();
  const rows = (await client.query(incrementalCatalogSql(ids))).rows;
  if (rows.length !== 1) {
    throw new PostgresCatalogFullRefreshRequired(
      "targeted PostgreSQL catalog query returned an invalid result",
    );
  }
  const definitions = catalogDefinitions(rows[0]);
  const introspectionMs = performance.now() - introspectionStarted;

  const materializationStarted = performance.now();
  const upsertDocuments = buildDocuments(identity, definitions);
  const removeDocumentUris = new Set(documentUris);
  for (const document of upsertDocuments) removeDocumentUris.delete(document.uri);
  return {
    upsertDocuments,
    removeDocumentUris: [...removeDocumentUris],
    origins: catalogOrigins(identity, definitions),
    affectedRelationOids: [
      ...definitions.tables.map((table) => Number(table.tableOid)),
      ...definitions.views.map((view) => Number(view.oid)),
    ],
    foreignKeys: definitions.constraints.flatMap((constraint) =>
      constraint.referencedTableOid
        ? [
            {
              sourceTableOid: Number(constraint.tableOid),
              targetTableOid: Number(constraint.referencedTableOid),
              sourceColumns: constraint.sourceColumns,
              sourceColumnsNullable: constraint.sourceColumnsNullable,
              targetColumns: constraint.referencedColumns,
              validated: constraint.validated,
            },
          ]
        : [],
    ),
    viewDependencies: definitions.viewDependencies.map((dependency) => ({
      sourceViewOid: Number(dependency.sourceViewOid),
      targetRelationOid: Number(dependency.targetRelationOid),
    })),
    introspectionMs,
    materializationMs: performance.now() - materializationStarted,
  };
}

export function buildPostgresSourceSet(
  identity: PostgresCatalogIdentity,
  documents: readonly VirtualSqlDocument[],
  origins: ReadonlyMap<string, PostgresCatalogObjectOrigin>,
): VirtualSqlSourceSet {
  const ordered = [...documents].sort((left, right) => left.uri.localeCompare(right.uri));
  return {
    srcset: postgresSourceSetName(identity),
    revision: sourceSetRevision(ordered, origins),
    documents: ordered,
  };
}

interface IncrementalCatalogIds {
  relationIds: number[];
  routineIds: number[];
  triggerIds: number[];
  constraintIds: number[];
  schemaIds: number[];
}

function incrementalCatalogSql(ids: IncrementalCatalogIds): string {
  const relations = numericList(ids.relationIds);
  const routines = numericList(ids.routineIds);
  const triggers = numericList(ids.triggerIds);
  const constraints = numericList(ids.constraintIds);
  const schemas = numericList(ids.schemaIds);
  const affectedRelationSelection = (
    relationOid: string,
  ) => `(${relationOid} IN (${relations}) OR ${relationOid} IN (
    SELECT selected_constraint.conrelid
    FROM pg_catalog.pg_constraint AS selected_constraint
    WHERE selected_constraint.oid IN (${constraints})
  ))`;
  const relationSelection = affectedRelationSelection("relation.oid");
  return catalogSql(
    appendCatalogFilter(SCHEMAS_SQL, `namespace.oid IN (${schemas})`),
    appendCatalogFilter(TABLES_SQL, relationSelection),
    appendCatalogFilter(COLUMNS_SQL, relationSelection),
    appendCatalogFilter(
      CONSTRAINTS_SQL,
      `(${affectedRelationSelection("constraint_row.conrelid")} OR ${affectedRelationSelection("constraint_row.confrelid")} OR constraint_row.oid IN (${constraints}))`,
    ),
    appendCatalogFilter(VIEWS_SQL, relationSelection),
    appendCatalogFilter(
      VIEW_DEPENDENCIES_SQL,
      `(${affectedRelationSelection("view_relation.oid")} OR ${affectedRelationSelection("target_relation.oid")})`,
    ),
    appendCatalogFilter(ROUTINES_SQL, `routine.oid IN (${routines})`),
    appendCatalogFilter(TRIGGERS_SQL, `trigger_row.oid IN (${triggers})`),
    "workbench:catalog-incremental",
  );
}

function appendCatalogFilter(sql: string, condition: string): string {
  const order = sql.lastIndexOf("ORDER BY");
  if (order < 0) throw new Error("Workbench catalog query has no ORDER BY clause");
  return `${sql.slice(0, order)}AND ${condition}\n${sql.slice(order)}`;
}

function numericList(values: readonly number[]): string {
  return values.length > 0 ? values.join(", ") : "0";
}

function catalogDefinitions(catalog: Record<string, unknown>): CatalogDefinitionRows {
  return {
    schemas: requiredRows(catalog.schemas, "schemas").map(schemaRow),
    tables: requiredRows(catalog.tables, "tables").map(tableRow),
    columns: requiredRows(catalog.columns, "columns").map(tableColumnRow),
    constraints: requiredRows(catalog.constraints, "constraints").map(constraintRow),
    views: requiredRows(catalog.views, "views").map(definitionRow),
    viewDependencies: requiredRows(catalog.view_dependencies, "view dependencies").map(
      viewDependencyRow,
    ),
    routines: requiredRows(catalog.routines, "routines").map(definitionRow),
    triggers: requiredRows(catalog.triggers, "triggers").map(definitionRow),
  };
}

function catalogOrigins(
  identity: PostgresCatalogIdentity,
  catalog: CatalogDefinitionRows,
): Map<string, PostgresCatalogObjectOrigin> {
  const origins = new Map<string, PostgresCatalogObjectOrigin>();
  const add = (schema: string, kind: string, name: string, extension?: string) => {
    origins.set(
      postgresDocumentUri(identity, schema, kind, name),
      extension ? { kind: "extension", extension } : { kind: "database" },
    );
  };
  for (const schema of catalog.schemas) add(schema.schemaName, "schema", schema.schemaName);
  for (const table of catalog.tables) {
    add(table.schemaName, "table", table.tableName, table.extensionName);
  }
  for (const view of catalog.views)
    add(view.schemaName, "view", view.objectName, view.extensionName);
  for (const routine of catalog.routines) {
    add(
      routine.schemaName,
      "routine",
      `${routine.objectName}(${routine.identityArguments})`,
      routine.extensionName,
    );
  }
  for (const trigger of catalog.triggers) {
    add(
      trigger.schemaName,
      "trigger",
      `${trigger.relationName ? `${trigger.relationName}.` : ""}${trigger.objectName}`,
      trigger.extensionName,
    );
  }
  return origins;
}

function buildDocuments(
  identity: PostgresCatalogIdentity,
  catalog: CatalogDefinitionRows,
): VirtualSqlDocument[] {
  const documents: VirtualSqlDocument[] = catalog.schemas.map((schema) => ({
    uri: postgresDocumentUri(identity, schema.schemaName, "schema", schema.schemaName),
    language: "sql",
    content: `CREATE SCHEMA ${quoteSqlIdentifier(schema.schemaName)};\n`,
    postgres: descriptor(identity, schema.schemaName, "schema", schema.oid, schema.schemaName),
  }));

  const tables = new Map<string, TableDefinition>(
    catalog.tables.map((table) => [
      table.tableOid,
      {
        oid: table.tableOid,
        schemaName: table.schemaName,
        tableName: table.tableName,
        columns: [],
        constraints: [],
      } satisfies TableDefinition,
    ]),
  );
  for (const column of catalog.columns) {
    tables.get(column.tableOid)?.columns.push(column);
  }
  for (const constraint of catalog.constraints) {
    tables.get(constraint.tableOid)?.constraints.push(constraint);
  }
  for (const table of tables.values()) {
    documents.push({
      uri: postgresDocumentUri(identity, table.schemaName, "table", table.tableName),
      language: "sql",
      content: renderTable(table),
      postgres: descriptor(identity, table.schemaName, "table", table.oid, table.tableName),
    });
  }

  for (const view of catalog.views) {
    documents.push({
      uri: postgresDocumentUri(identity, view.schemaName, "view", view.objectName),
      language: "sql",
      content: ensureStatement(
        `CREATE VIEW ${qualifiedName(view.schemaName, view.objectName)} AS\n${view.definition.trim()}`,
      ),
      postgres: descriptor(identity, view.schemaName, "view", view.oid, view.objectName),
    });
  }
  appendDefinitions(documents, identity, "routine", catalog.routines);
  appendDefinitions(documents, identity, "trigger", catalog.triggers);

  documents.sort((left, right) => left.uri.localeCompare(right.uri));
  return documents;
}

function appendDefinitions(
  documents: VirtualSqlDocument[],
  identity: PostgresCatalogIdentity,
  kind: "routine" | "trigger",
  definitions: DefinitionRow[],
): void {
  for (const definition of definitions) {
    const identityName =
      kind === "routine"
        ? `${definition.objectName}(${definition.identityArguments})`
        : `${definition.relationName ? `${definition.relationName}.` : ""}${definition.objectName}`;
    documents.push({
      uri: postgresDocumentUri(identity, definition.schemaName, kind, identityName),
      language: "sql",
      content: ensureStatement(definition.definition),
      postgres: descriptor(
        identity,
        definition.schemaName,
        kind,
        definition.oid,
        definition.objectName,
        definition.identityArguments,
      ),
    });
  }
}

function renderTable(table: TableDefinition): string {
  const members = [
    ...table.columns
      .sort((left, right) => left.columnNumber - right.columnNumber)
      .map(renderColumn),
    ...table.constraints
      .sort((left, right) => left.constraintOid.localeCompare(right.constraintOid))
      .map(
        (constraint) =>
          `CONSTRAINT ${quoteSqlIdentifier(constraint.constraintName)} ${constraint.definition}`,
      ),
  ];
  return (
    `CREATE TABLE ${qualifiedName(table.schemaName, table.tableName)} (\n` +
    `${members.map((member) => `  ${member}`).join(",\n")}\n` +
    ");\n"
  );
}

function renderColumn(column: TableColumnRow): string {
  let definition = `${quoteSqlIdentifier(column.columnName)} ${column.dataType}`;
  if (column.identityKind === "a") {
    definition += " GENERATED ALWAYS AS IDENTITY";
  } else if (column.identityKind === "d") {
    definition += " GENERATED BY DEFAULT AS IDENTITY";
  } else if (column.generatedKind === "s" && column.defaultExpression) {
    definition += ` GENERATED ALWAYS AS (${column.defaultExpression}) STORED`;
  } else if (column.defaultExpression) {
    definition += ` DEFAULT ${column.defaultExpression}`;
  }
  if (column.notNull) {
    definition += " NOT NULL";
  }
  return definition;
}

export function postgresDocumentUri(
  identity: PostgresCatalogIdentity,
  schemaName: string,
  kind: string,
  semanticName: string,
): string {
  return (
    postgresDatabaseDocumentRoot(identity) +
    `${encodeURIComponent(schemaName)}/${kind}/${encodeURIComponent(semanticName)}.sql`
  );
}

export function postgresDatabaseDocumentRoot(identity: PostgresCatalogIdentity): string {
  return `postgresql://${encodeURIComponent(identity.connectionId)}/${encodeURIComponent(identity.database)}/`;
}

export function postgresDatabaseDocumentGlob(identity: PostgresCatalogIdentity): string {
  return `${postgresDatabaseDocumentRoot(identity)}**`;
}

function descriptor(
  identity: PostgresCatalogIdentity,
  schema: string,
  documentKind: PostgresDocumentDescriptor["documentKind"],
  oid: string,
  name: string,
  signature = "",
): PostgresDocumentDescriptor {
  return {
    ...identity,
    schema,
    documentKind,
    oid: Number(oid),
    name,
    signature,
  };
}

function qualifiedName(schemaName: string, objectName: string): string {
  return `${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(objectName)}`;
}

function ensureStatement(sql: string): string {
  const trimmed = sql.trim();
  return `${trimmed.endsWith(";") ? trimmed : `${trimmed};`}\n`;
}

function sourceSetRevision(
  documents: VirtualSqlDocument[],
  origins: ReadonlyMap<string, PostgresCatalogObjectOrigin>,
): string {
  const hash = createHash("sha256");
  for (const document of documents) {
    hash.update(document.uri);
    hash.update("\0");
    hash.update(document.content);
    hash.update("\0");
  }
  for (const [uri, origin] of [...origins.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(uri);
    hash.update("\0");
    hash.update(origin.kind);
    hash.update("\0");
    if (origin.kind === "extension") hash.update(origin.extension);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function postgresSourceSetName(identity: PostgresCatalogIdentity): string {
  const hash = createHash("sha256");
  hash.update(postgresDatabaseDocumentRoot(identity));
  return `postgres-${hash.digest("hex").slice(0, 20)}`;
}

function schemaRow(row: Record<string, unknown>): SchemaRow {
  return {
    oid: requiredString(row.oid, "schema oid"),
    schemaName: requiredString(row.schema_name, "schema name"),
  };
}

function tableColumnRow(row: Record<string, unknown>): TableColumnRow {
  return {
    ...tableRow(row),
    columnNumber: requiredNumber(row.column_number, "column number"),
    columnName: requiredString(row.column_name, "column name"),
    dataType: requiredString(row.data_type, "column type"),
    notNull: requiredBoolean(row.not_null, "not-null flag"),
    defaultExpression: optionalString(row.default_expr),
    identityKind: optionalString(row.identity_kind) ?? "",
    generatedKind: optionalString(row.generated_kind) ?? "",
  };
}

function tableRow(row: Record<string, unknown>): TableRow {
  return {
    tableOid: requiredString(row.table_oid, "table oid"),
    schemaName: requiredString(row.schema_name, "table schema"),
    tableName: requiredString(row.table_name, "table name"),
    extensionName: optionalString(row.extension_name),
  };
}

function constraintRow(row: Record<string, unknown>): ConstraintRow {
  return {
    tableOid: requiredString(row.table_oid, "constraint table oid"),
    constraintOid: requiredString(row.constraint_oid, "constraint oid"),
    constraintName: requiredString(row.constraint_name, "constraint name"),
    definition: requiredString(row.definition, "constraint definition"),
    referencedTableOid: optionalString(row.referenced_table_oid),
    sourceColumns: optionalStringArray(row.source_columns),
    sourceColumnsNullable: optionalBooleanArray(row.source_columns_nullable),
    referencedColumns: optionalStringArray(row.referenced_columns),
    validated: requiredBoolean(row.validated, "constraint validation flag"),
  };
}

function viewDependencyRow(row: Record<string, unknown>): ViewDependencyRow {
  return {
    sourceViewOid: requiredString(row.source_view_oid, "source view oid"),
    targetRelationOid: requiredString(row.target_relation_oid, "target relation oid"),
  };
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function optionalBooleanArray(value: unknown): boolean[] {
  return Array.isArray(value) && value.every((item) => typeof item === "boolean") ? value : [];
}

function definitionRow(row: Record<string, unknown>): DefinitionRow {
  return {
    oid: requiredString(row.oid, "definition oid"),
    schemaName: requiredString(row.schema_name, "definition schema"),
    objectName: requiredString(row.object_name, "definition name"),
    definition: requiredString(row.definition, "definition SQL"),
    extensionName: optionalString(row.extension_name),
    identityArguments: optionalString(row.identity_arguments) ?? "",
    relationName: optionalString(row.relation_name),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`PostgreSQL catalog returned an invalid ${field}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`PostgreSQL catalog returned an invalid ${field}`);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`PostgreSQL catalog returned an invalid ${field}`);
}

function requiredRows(value: unknown, field: string): Record<string, unknown>[] {
  if (
    Array.isArray(value) &&
    value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))
  ) {
    return value as Record<string, unknown>[];
  }
  throw new Error(`PostgreSQL catalog returned invalid ${field}`);
}
