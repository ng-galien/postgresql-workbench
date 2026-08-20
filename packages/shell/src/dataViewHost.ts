import { Client } from "pg";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../../catalog/src/localCodeMoniker.js";
import { readPostgresCatalog } from "../../catalog/src/postgresCatalog.js";
import { composeIntoDataViewQuery, dataViewAdditions } from "../../rows/src/additions.js";
import type { SqlResultSession } from "../../rows/src/cursor.js";
import type { DataViewAddition, DataViewProjection } from "../../rows/src/dataView.js";
import { localFilterCompletions } from "../../rows/src/filterCompletions.js";
import { initialDataViewQuery } from "../../rows/src/initialProjection.js";
import { openDataViewResult, TableAccents } from "../../rows/src/openRows.js";
import { createCodeMonikerSyntaxParser } from "../../sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { composePostgresSql } from "../../sql/src/query/composition.js";
import { type QueryRewrite, SqlQueryModel } from "../../sql/src/query/model.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringDragPayload,
  type SqlAuthoringSnapshot,
} from "../../sql/src/snapshot.js";
import type {
  DataViewRequest,
  DataViewResponse,
  DataViewState,
} from "../../views/src/dataView/protocol.js";

/**
 * The Data View's Extension Host, without VS Code. Every other part is the real one: PostgreSQL
 * answers the rows, Code Moniker parses the SQL, and the composition engine plans the joins — so
 * what the view is driven against here is what it is driven against in the product.
 *
 * It runs the developer harness and, in a test, drives the view directly.
 */
export interface DataViewHostOptions {
  connection: { host: string; port: number; user: string; password: string; database: string };
  schema: string;
  relation: string;
  /** Where the responses go: the browser bridge, or a test's recorder. */
  emit(response: DataViewResponse): void;
}

export interface DataViewDevHost {
  handle(request: DataViewRequest): Promise<void>;
  /** Puts the query back to the one the view opens with, so a scenario starts from a known state. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startDataViewHost(options: DataViewHostOptions): Promise<DataViewDevHost> {
  const { connection, schema, relation, emit } = options;
  const serverId = `${connection.host}:${connection.port}/${connection.database}:${connection.user}`;

  const session: LocalCodeMonikerSession = await ensureLocalCodeMonikerWorkspace({
    workspaceRoots: [process.cwd()],
    clientName: "postgresql-workbench-data-view-dev",
  });
  const parser: SyntaxParser = createCodeMonikerSyntaxParser(session.client);

  const client = new Client(connection);
  await client.connect();
  const snapshot = await readSnapshot(client, serverId, connection.database);

  const source = {
    kind: "relation" as const,
    serverId,
    database: connection.database,
    schema,
    name: relation,
    relationKind: "table" as const,
  };
  const query = new SqlQueryModel(async () => parser);
  const initialText = await initialDataViewQuery(
    source,
    snapshot,
    DEFAULT_SQL_AUTHORING_SETTINGS,
    async () => columnNames(client, schema, relation),
  );
  await query.setText(initialText);

  const accents = new TableAccents();
  const state: {
    projection: DataViewProjection;
    hidden: string[];
    status: DataViewState["status"];
    message?: string;
    payload?: DataViewState["payload"];
    editability: DataViewState["editability"];
    busy: boolean;
    session?: SqlResultSession;
  } = {
    projection: { tables: [], columnTable: [] },
    hidden: [],
    status: "loading",
    editability: { tables: [], columns: [] },
    busy: false,
  };

  const broadcast = () =>
    emit({
      type: "data-view/state",
      state: {
        source,
        serverName: connection.database,
        query: {
          uri: `data-view:/${schema}.${relation}.sql`,
          text: query.text,
          ...(query.whereText() === undefined ? {} : { whereText: query.whereText() }),
          orderBy: query.orderBy(),
          hidden: state.hidden,
          structured: query.analysis !== undefined,
          ...(query.problem ? { problem: query.problem } : {}),
          editorDirty: false,
        },
        projection: state.projection,
        status: state.status,
        ...(state.message ? { message: state.message } : {}),
        ...(state.payload ? { payload: state.payload } : {}),
        editability: state.editability,
        edits: [],
        busy: state.busy,
        applying: false,
      },
    });

  const load = async () => {
    state.busy = true;
    broadcast();
    // A cursor owns the connection it reads through, so every load opens its own, exactly as the
    // Extension Host does: the previous one goes with the session it belonged to.
    await state.session?.close().catch(() => {});
    const reader = new Client(connection);
    await reader.connect();
    try {
      const opened = await openDataViewResult({
        client: reader,
        sql: query.effectiveSql(),
        settings: { pageSize: 200, maxCachedRows: 5_000, cursorIdleTimeoutSeconds: 300 },
        binding: { serverId, serverName: connection.database, database: connection.database },
        accents,
        checkpoint: () => {},
      });
      state.session = opened.session;
      state.payload = opened.session.snapshot();
      state.editability = opened.editability;
      state.projection = opened.projection;
      state.status = "ready";
      state.message = undefined;
    } catch (error) {
      state.status = "error";
      state.message = error instanceof Error ? error.message : String(error);
      await reader.end().catch(() => {});
    } finally {
      state.busy = false;
      broadcast();
    }
  };

  const rewrite = async (next: QueryRewrite | Promise<QueryRewrite>) => {
    const outcome = await next;
    if (outcome.status === "unchanged") return;
    if (outcome.status === "rejected") {
      emit({ type: "data-view/notice", message: outcome.message, severity: "info" });
      return;
    }
    await query.setText(outcome.text);
    await load();
  };

  const compose = async (addition: DataViewAddition, relationChoice?: number) => {
    const outcome = await composeIntoDataViewQuery({
      text: query.text,
      statementEnd: query.analysis?.statement.end ?? 0,
      uri: `data-view:/${schema}.${relation}.sql`,
      payload: addition.payload as SqlAuthoringDragPayload,
      ...(relationChoice === undefined ? {} : { relationChoice }),
      settings: DEFAULT_SQL_AUTHORING_SETTINGS,
      parser,
      // The server would guard the snapshot; here the engine answers directly.
      compose: async (request) =>
        composePostgresSql(request, snapshot, DEFAULT_SQL_AUTHORING_SETTINGS, query.analysis),
    });
    if (outcome.status === "rejected") {
      emit({ type: "data-view/notice", message: outcome.message, severity: "info" });
      return;
    }
    if (outcome.status === "ambiguous") {
      emit({
        type: "data-view/choices",
        addition,
        title: outcome.title,
        choices: outcome.choices,
      });
      return;
    }
    await query.setText(outcome.text);
    await load();
  };

  return {
    async reset() {
      state.hidden = [];
      await query.setText(initialText);
      await load();
    },
    async handle(request) {
      switch (request.type) {
        case "data-view/ready":
          await load();
          return;
        case "data-view/refresh":
          await load();
          return;
        case "data-view/sort":
          await rewrite(query.sorted(request.sorts, 2));
          return;
        case "data-view/filter":
          await rewrite(query.filtered(request.text, 2));
          return;
        case "data-view/reorder":
          await rewrite(
            query.reordered(
              request.from,
              request.to,
              state.payload?.columns.map((column) => column.name) ?? [],
              2,
            ),
          );
          return;
        case "data-view/reorder-table":
          await rewrite(
            query.tableBlockMoved(state.projection.columnTable, request.from, request.to, 2),
          );
          return;
        case "data-view/remove-table": {
          const table = state.projection.tables[request.tableIndex];
          if (!table) return;
          await rewrite(
            query.relationRemoved(
              table,
              state.projection.columnTable.flatMap((owner, ordinal) =>
                owner === request.tableIndex ? [ordinal] : [],
              ),
              2,
            ),
          );
          return;
        }
        case "data-view/hide":
          state.hidden = [...state.hidden.filter((key) => key !== request.column), request.column];
          broadcast();
          return;
        case "data-view/unhide":
          state.hidden =
            request.column === undefined
              ? []
              : state.hidden.filter((key) => key !== request.column);
          broadcast();
          return;
        case "data-view/additions":
          emit({
            type: "data-view/additions",
            items: dataViewAdditions(
              state.projection,
              new Set(state.payload?.columns.map((column) => column.name) ?? []),
              snapshot,
            ),
          });
          return;
        case "data-view/compose":
          await compose(request.addition, request.relationChoice);
          return;
        case "data-view/complete":
          emit({
            type: "data-view/completions",
            requestId: request.requestId,
            items: query.analysis
              ? localFilterCompletions(query.analysis, request.text, request.offset)
              : [],
          });
          return;
        case "data-view/navigate": {
          const cursor = state.session;
          if (!cursor) return;
          state.payload =
            request.action === "next"
              ? await cursor.next()
              : request.action === "previous"
                ? await cursor.previous()
                : request.action === "load-all"
                  ? await cursor.loadAll()
                  : cursor.snapshot();
          broadcast();
          return;
        }
        case "data-view/export":
          emit({
            type: "data-view/notice",
            message: `Exported ${request.scope} rows as ${request.format.toUpperCase()}.`,
            severity: "info",
          });
          return;
        default:
          emit({
            type: "data-view/notice",
            message: `${request.type} needs VS Code and is not part of this harness.`,
            severity: "info",
          });
      }
    },
    async dispose() {
      await state.session?.close?.().catch(() => {});
      await client.end().catch(() => {});
      await session.dispose?.().catch(() => {});
    },
  };
}

/** The indexed objects and foreign keys the composition engine plans joins from. */
async function readSnapshot(
  client: Client,
  serverId: string,
  database: string,
): Promise<SqlAuthoringSnapshot> {
  const catalog = await readPostgresCatalog(client, { serverId, database });
  const relations = await client.query<{
    oid: number;
    schema: string;
    name: string;
    kind: string;
    columns: { name: string; type: string }[] | null;
  }>(`
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
           (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'v')
    ORDER BY n.nspname, c.relname`);
  return {
    status: "available",
    serverId,
    database,
    revision: "dev",
    generation: 1,
    objects: relations.rows.map((row) => ({
      serverId,
      database,
      schema: row.schema,
      oid: Number(row.oid),
      name: row.name,
      kind: row.kind === "v" ? "view" : "table",
      signature: "",
      parameters: [],
      columns: row.columns ?? [],
    })),
    foreignKeys: catalog.foreignKeys,
  };
}

/** The relation's own columns, for the projection a Data View opens with. */
async function columnNames(client: Client, schema: string, relation: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, relation],
  );
  return result.rows.map((row) => row.name);
}
