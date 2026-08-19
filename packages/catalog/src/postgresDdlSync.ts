import { quoteSqlIdentifier } from "../../sql/src/text/identifiers.js";

export const WORKBENCH_DDL_CHANNEL = "plpgsql_workbench_ddl";
export const WORKBENCH_DDL_PAYLOAD_VERSION = 1;

const SUPPORT_MARKER = "postgresql-workbench-schema-sync:v1";
const DDL_TRIGGER = "plpgsql_workbench_ddl_command_end";
const DROP_TRIGGER = "plpgsql_workbench_sql_drop";

export type PostgresDdlEventKind = "ddl_command_end" | "sql_drop";
export type PostgresDdlResourceKind = "relation" | "routine" | "trigger" | "constraint" | "schema";

export interface PostgresDdlObject {
  classId: number;
  objectId: number;
  objectSubId: number;
  resourceKind?: PostgresDdlResourceKind;
  commandTag?: string;
  objectType: string;
  schemaName?: string;
  objectName?: string;
  objectIdentity: string;
  inExtension?: boolean;
  original?: boolean;
}

export interface PostgresDdlNotification {
  version: 1;
  databaseOid: number;
  transactionId: string;
  event: PostgresDdlEventKind;
  objects: PostgresDdlObject[];
  fallback?: boolean;
  reason?: string;
}

export interface CoalescedPostgresDdlNotification {
  databaseOid: number;
  transactionId: string;
  objects: PostgresDdlObject[];
  fallback: boolean;
  reasons: string[];
}

export function validateSupportSchema(value: string): string {
  const schema = value.trim();
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      "The Workbench support schema must be a lower-case, unquoted PostgreSQL identifier",
    );
  }
  if (Buffer.byteLength(schema, "utf8") > 63) {
    throw new Error("The Workbench support schema must not exceed 63 bytes");
  }
  if (schema.startsWith("pg_")) {
    throw new Error("PostgreSQL reserves schema names beginning with pg_");
  }
  return schema;
}

export function parsePostgresDdlNotification(payload: string): PostgresDdlNotification {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("The PostgreSQL DDL notification is not valid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("The PostgreSQL DDL notification is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== WORKBENCH_DDL_PAYLOAD_VERSION) {
    throw new Error(`Unsupported PostgreSQL DDL notification version: ${String(candidate.v)}`);
  }
  const databaseOid = positiveInteger(candidate.db, "database OID");
  const transactionId = requiredString(candidate.tx, "transaction ID");
  const event = candidate.event;
  if (event !== "ddl_command_end" && event !== "sql_drop") {
    throw new Error(`Unsupported PostgreSQL DDL event: ${String(event)}`);
  }
  const rawObjects = Array.isArray(candidate.objects) ? candidate.objects : [];
  const objects = rawObjects.map(parseObject);
  return {
    version: 1,
    databaseOid,
    transactionId,
    event,
    objects,
    fallback: candidate.fallback === true || undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
  };
}

export function coalescePostgresDdlNotifications(
  notifications: readonly PostgresDdlNotification[],
): CoalescedPostgresDdlNotification[] {
  const grouped = new Map<string, CoalescedPostgresDdlNotification>();
  for (const notification of notifications) {
    const key = `${notification.databaseOid}:${notification.transactionId}`;
    const group = grouped.get(key) ?? {
      databaseOid: notification.databaseOid,
      transactionId: notification.transactionId,
      objects: [],
      fallback: false,
      reasons: [],
    };
    group.fallback ||= notification.fallback === true;
    if (notification.reason && !group.reasons.includes(notification.reason)) {
      group.reasons.push(notification.reason);
    }
    const identities = new Set(
      group.objects.map(
        (object) =>
          `${object.classId}:${object.objectId}:${object.objectSubId}:${object.objectType}:${object.objectIdentity}:${object.original === true}`,
      ),
    );
    for (const object of notification.objects) {
      const identity = `${object.classId}:${object.objectId}:${object.objectSubId}:${object.objectType}:${object.objectIdentity}:${object.original === true}`;
      if (!identities.has(identity)) {
        identities.add(identity);
        group.objects.push(object);
      }
    }
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

export function buildWorkbenchDdlProvisioningSql(supportSchema: string): string {
  const schema = quoteSqlIdentifier(validateSupportSchema(supportSchema));
  const ddlFunction = `${schema}.notify_ddl_command_end`;
  const dropFunction = `${schema}.notify_sql_drop`;
  return `
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('postgresql-workbench-schema-sync'));
CREATE SCHEMA IF NOT EXISTS ${schema};

DO $workbench$
BEGIN
  IF pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_ddl_command_end()`)} ) IS NOT NULL
    AND pg_catalog.obj_description(pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_ddl_command_end()`)} ), 'pg_proc') IS DISTINCT FROM '${SUPPORT_MARKER}'
  THEN
    RAISE EXCEPTION 'function ${validateSupportSchema(supportSchema)}.notify_ddl_command_end() already exists and is not owned by PL/pgSQL Workbench';
  END IF;
  IF pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_sql_drop()`)} ) IS NOT NULL
    AND pg_catalog.obj_description(pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_sql_drop()`)} ), 'pg_proc') IS DISTINCT FROM '${SUPPORT_MARKER}'
  THEN
    RAISE EXCEPTION 'function ${validateSupportSchema(supportSchema)}.notify_sql_drop() already exists and is not owned by PL/pgSQL Workbench';
  END IF;
END
$workbench$;

CREATE OR REPLACE FUNCTION ${ddlFunction}()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $workbench$
DECLARE
  payload jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'v', ${WORKBENCH_DDL_PAYLOAD_VERSION},
    'db', (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    'tx', pg_catalog.txid_current()::text,
    'event', 'ddl_command_end',
    'objects', COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'classid', command.classid,
      'objid', command.objid,
      'objsubid', command.objsubid,
      'resource_kind', CASE command.classid
        WHEN 'pg_catalog.pg_class'::pg_catalog.regclass THEN CASE
          WHEN command.object_type IN ('table', 'partitioned table', 'view', 'table column')
            THEN 'relation'
          ELSE NULL
        END
        WHEN 'pg_catalog.pg_proc'::pg_catalog.regclass THEN 'routine'
        WHEN 'pg_catalog.pg_trigger'::pg_catalog.regclass THEN 'trigger'
        WHEN 'pg_catalog.pg_constraint'::pg_catalog.regclass THEN 'constraint'
        WHEN 'pg_catalog.pg_namespace'::pg_catalog.regclass THEN 'schema'
        ELSE NULL
      END,
      'command_tag', command.command_tag,
      'object_type', command.object_type,
      'schema_name', command.schema_name,
      'object_identity', command.object_identity,
      'in_extension', command.in_extension
    )), '[]'::jsonb)
  ) INTO payload
  FROM pg_catalog.pg_event_trigger_ddl_commands() AS command
  WHERE command.object_type <> 'event trigger'
    AND NOT (
      command.object_type = 'function'
      AND command.schema_name = ${sqlLiteral(validateSupportSchema(supportSchema))}
      AND command.objid IN (
        pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_ddl_command_end()`)} )::oid,
        pg_catalog.to_regprocedure(${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_sql_drop()`)} )::oid
      )
    );
  IF pg_catalog.octet_length(payload::text) >= 7900 THEN
    payload := pg_catalog.jsonb_build_object(
      'v', ${WORKBENCH_DDL_PAYLOAD_VERSION}, 'db', (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
      'tx', pg_catalog.txid_current()::text, 'event', 'ddl_command_end',
      'objects', '[]'::jsonb, 'fallback', true, 'reason', 'payload-too-large'
    );
  END IF;
  IF pg_catalog.jsonb_array_length(payload->'objects') > 0 OR (payload->>'fallback')::boolean THEN
    PERFORM pg_catalog.pg_notify('${WORKBENCH_DDL_CHANNEL}', payload::text);
  END IF;
END
$workbench$;
COMMENT ON FUNCTION ${ddlFunction}() IS '${SUPPORT_MARKER}';

CREATE OR REPLACE FUNCTION ${dropFunction}()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $workbench$
DECLARE
  payload jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'v', ${WORKBENCH_DDL_PAYLOAD_VERSION},
    'db', (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    'tx', pg_catalog.txid_current()::text,
    'event', 'sql_drop',
    'objects', COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'classid', dropped.classid,
      'objid', dropped.objid,
      'objsubid', dropped.objsubid,
      'resource_kind', CASE dropped.classid
        WHEN 'pg_catalog.pg_class'::pg_catalog.regclass THEN CASE
          WHEN dropped.object_type IN ('table', 'partitioned table', 'view', 'table column')
            THEN 'relation'
          ELSE NULL
        END
        WHEN 'pg_catalog.pg_proc'::pg_catalog.regclass THEN 'routine'
        WHEN 'pg_catalog.pg_trigger'::pg_catalog.regclass THEN 'trigger'
        WHEN 'pg_catalog.pg_constraint'::pg_catalog.regclass THEN 'constraint'
        WHEN 'pg_catalog.pg_namespace'::pg_catalog.regclass THEN 'schema'
        ELSE NULL
      END,
      'object_type', dropped.object_type,
      'schema_name', dropped.schema_name,
      'object_name', dropped.object_name,
      'object_identity', dropped.object_identity,
      'original', dropped.original
    )), '[]'::jsonb)
  ) INTO payload
  FROM pg_catalog.pg_event_trigger_dropped_objects() AS dropped
  WHERE dropped.is_temporary = false
    AND dropped.object_type <> 'event trigger'
    AND NOT (
      dropped.object_type = 'function'
      AND dropped.schema_name = ${sqlLiteral(validateSupportSchema(supportSchema))}
      AND dropped.object_identity IN (
        ${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_ddl_command_end()`)},
        ${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_sql_drop()`)}
      )
    );
  IF pg_catalog.octet_length(payload::text) >= 7900 THEN
    payload := pg_catalog.jsonb_build_object(
      'v', ${WORKBENCH_DDL_PAYLOAD_VERSION}, 'db', (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
      'tx', pg_catalog.txid_current()::text, 'event', 'sql_drop',
      'objects', '[]'::jsonb, 'fallback', true, 'reason', 'payload-too-large'
    );
  END IF;
  IF pg_catalog.jsonb_array_length(payload->'objects') > 0 OR (payload->>'fallback')::boolean THEN
    PERFORM pg_catalog.pg_notify('${WORKBENCH_DDL_CHANNEL}', payload::text);
  END IF;
END
$workbench$;
COMMENT ON FUNCTION ${dropFunction}() IS '${SUPPORT_MARKER}';

DO $workbench$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DDL_TRIGGER}'
      AND (
        evtfoid <> ${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_ddl_command_end()`)}::pg_catalog.regprocedure
        OR evtevent <> 'ddl_command_end'
        OR evttags IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'event trigger ${DDL_TRIGGER} already exists and is not owned by PL/pgSQL Workbench';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = '${DDL_TRIGGER}') THEN
    CREATE EVENT TRIGGER ${DDL_TRIGGER} ON ddl_command_end
      EXECUTE FUNCTION ${ddlFunction}();
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DROP_TRIGGER}'
      AND (
        evtfoid <> ${sqlLiteral(`${validateSupportSchema(supportSchema)}.notify_sql_drop()`)}::pg_catalog.regprocedure
        OR evtevent <> 'sql_drop'
        OR evttags IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'event trigger ${DROP_TRIGGER} already exists and is not owned by PL/pgSQL Workbench';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = '${DROP_TRIGGER}') THEN
    CREATE EVENT TRIGGER ${DROP_TRIGGER} ON sql_drop
      EXECUTE FUNCTION ${dropFunction}();
  END IF;
END
$workbench$;
COMMIT;
`;
}

export function buildWorkbenchDdlRemovalSql(supportSchema: string): string {
  const rawSchema = validateSupportSchema(supportSchema);
  const schema = quoteSqlIdentifier(rawSchema);
  return `
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('postgresql-workbench-schema-sync'));
DO $workbench$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DDL_TRIGGER}'
      AND evtfoid = pg_catalog.to_regprocedure(${sqlLiteral(`${rawSchema}.notify_ddl_command_end()`)} )
      AND evtevent = 'ddl_command_end'
      AND evttags IS NULL
  ) THEN
    DROP EVENT TRIGGER ${DDL_TRIGGER};
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DROP_TRIGGER}'
      AND evtfoid = pg_catalog.to_regprocedure(${sqlLiteral(`${rawSchema}.notify_sql_drop()`)} )
      AND evtevent = 'sql_drop'
      AND evttags IS NULL
  ) THEN
    DROP EVENT TRIGGER ${DROP_TRIGGER};
  END IF;
  IF pg_catalog.obj_description(
    pg_catalog.to_regprocedure(${sqlLiteral(`${rawSchema}.notify_ddl_command_end()`)} ),
    'pg_proc'
  ) = '${SUPPORT_MARKER}'
  THEN
    DROP FUNCTION ${schema}.notify_ddl_command_end();
  END IF;
  IF pg_catalog.obj_description(
    pg_catalog.to_regprocedure(${sqlLiteral(`${rawSchema}.notify_sql_drop()`)} ),
    'pg_proc'
  ) = '${SUPPORT_MARKER}'
  THEN
    DROP FUNCTION ${schema}.notify_sql_drop();
  END IF;
END
$workbench$;
COMMIT;
`;
}

export function workbenchDdlProvisioningStatusSql(supportSchema: string): string {
  const schema = validateSupportSchema(supportSchema);
  return `
SELECT
  pg_catalog.to_regnamespace(${sqlLiteral(schema)}) IS NOT NULL AS schema_exists,
  pg_catalog.obj_description(
    pg_catalog.to_regprocedure(${sqlLiteral(`${schema}.notify_ddl_command_end()`)} ),
    'pg_proc'
  ) = '${SUPPORT_MARKER}' AS ddl_function_exists,
  pg_catalog.obj_description(
    pg_catalog.to_regprocedure(${sqlLiteral(`${schema}.notify_sql_drop()`)} ),
    'pg_proc'
  ) = '${SUPPORT_MARKER}' AS drop_function_exists,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DDL_TRIGGER}'
      AND evtfoid = pg_catalog.to_regprocedure(${sqlLiteral(`${schema}.notify_ddl_command_end()`)} )
      AND evtevent = 'ddl_command_end'
      AND evttags IS NULL
      AND evtenabled <> 'D'
  ) AS ddl_trigger_exists,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_event_trigger
    WHERE evtname = '${DROP_TRIGGER}'
      AND evtfoid = pg_catalog.to_regprocedure(${sqlLiteral(`${schema}.notify_sql_drop()`)} )
      AND evtevent = 'sql_drop'
      AND evttags IS NULL
      AND evtenabled <> 'D'
  ) AS drop_trigger_exists,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS database_oid
`;
}

function parseObject(value: unknown): PostgresDdlObject {
  if (!value || typeof value !== "object") {
    throw new Error("The PostgreSQL DDL object is invalid");
  }
  const object = value as Record<string, unknown>;
  return {
    classId: positiveInteger(object.classid, "class ID"),
    objectId: nonNegativeInteger(object.objid, "object ID"),
    objectSubId: nonNegativeInteger(object.objsubid, "object sub-ID"),
    resourceKind: postgresResourceKind(object.resource_kind),
    commandTag: optionalString(object.command_tag),
    objectType: requiredString(object.object_type, "object type"),
    schemaName: optionalString(object.schema_name),
    objectName: optionalString(object.object_name),
    objectIdentity: requiredString(object.object_identity, "object identity"),
    inExtension: object.in_extension === true || undefined,
    original: typeof object.original === "boolean" ? object.original : undefined,
  };
}

function postgresResourceKind(value: unknown): PostgresDdlResourceKind | undefined {
  if (
    value === "relation" ||
    value === "routine" ||
    value === "trigger" ||
    value === "constraint" ||
    value === "schema"
  ) {
    return value;
  }
  return undefined;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`The PostgreSQL DDL ${label} is invalid`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The PostgreSQL DDL ${label} is invalid`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The PostgreSQL DDL ${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
