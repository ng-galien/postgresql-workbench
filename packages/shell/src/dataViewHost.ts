import { Client } from "pg";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../../catalog/src/localCodeMoniker.js";
import { readPostgresCatalog } from "../../catalog/src/postgresCatalog.js";
import { composeIntoDataViewQuery, dataViewAdditions } from "../../rows/src/additions.js";
import { countLabel } from "../../rows/src/countLabel.js";
import type { SqlResultSession } from "../../rows/src/cursor.js";
import {
  type DataViewAddition,
  type DataViewCompletion,
  type DataViewProjection,
  type DataViewSource,
  dataViewRelationOwning,
  describeDeleteConsequences,
  withRequiredColumnsRevealed,
} from "../../rows/src/dataView.js";
import { localFilterCompletions } from "../../rows/src/filterCompletions.js";
import { initialDataViewQuery } from "../../rows/src/initialProjection.js";
import { openDataViewResult, TableAccents } from "../../rows/src/openRows.js";
import { type DataViewWriteHost, PendingEdits } from "../../rows/src/pendingEdits.js";
import { createCodeMonikerSyntaxParser } from "../../sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { type SqlQueryAnalysis, setWhere } from "../../sql/src/query/analysis.js";
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
import { startSqlLanguageServer } from "./languageServer.js";

/**
 * The Data View's Extension Host, without VS Code. Every other part is the real one: PostgreSQL
 * answers the rows, Code Moniker parses the SQL, and the composition engine plans the joins — so
 * what the view is driven against here is what it is driven against in the product.
 *
 * It runs the developer harness and, in a test, drives the view directly.
 */
export interface DataViewHostOptions {
  connection: { host: string; port: number; user: string; password: string; database: string };
  /** The relation the view opens on. Without one it opens empty, and composition starts there. */
  relation?: { schema: string; name: string };
  /** The bundled SQL authoring server; without one the WHERE input falls back to its own columns. */
  languageServerPath?: string;
  /** Whether identity and relationship columns start hidden. The product reads this from settings. */
  hideKeyColumns?: boolean;
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
  const { connection, relation, emit } = options;
  const hideKeyColumns = options.hideKeyColumns ?? true;
  const serverId = `${connection.host}:${connection.port}/${connection.database}:${connection.user}`;
  // The chip names the server it is connected to; the database is shown beside it, not in its place.
  const serverName = `${connection.host}:${connection.port}`;

  const session: LocalCodeMonikerSession = await ensureLocalCodeMonikerWorkspace({
    workspaceRoots: [process.cwd()],
    clientName: "postgresql-workbench-data-view-dev",
  });
  const parser: SyntaxParser = createCodeMonikerSyntaxParser(session.client);

  // A connection that dies — the database restarted, the server was stopped — is news to report,
  // not a reason for the shell to fall over. pg raises `error` on the client, and an unhandled one
  // takes the process with it.
  let catalogLost = false;
  const connect = async (isCatalog = false): Promise<Client> => {
    const opened = new Client(connection);
    opened.on("error", (error: Error) => {
      if (isCatalog) catalogLost = true;
      emit({
        type: "data-view/notice",
        message: `The PostgreSQL connection was lost: ${error.message}`,
        severity: "error",
      });
    });
    await opened.connect();
    return opened;
  };

  let client = await connect(true);
  const snapshot = await readSnapshot(client, serverId, connection.database);

  // The real completions come from the language server; it has no parser, and answers back here.
  const languageServer = options.languageServerPath
    ? await startSqlLanguageServer({
        serverPath: options.languageServerPath,
        parser,
        snapshot: () => snapshot,
      })
    : undefined;

  const source: DataViewSource = relation
    ? {
        kind: "relation",
        serverId,
        database: connection.database,
        schema: relation.schema,
        name: relation.name,
        relationKind: "table",
      }
    : { kind: "sql", serverId, database: connection.database, sql: "", label: "" };
  const queryUri = relation
    ? `data-view:/${relation.schema}.${relation.name}.sql`
    : "data-view:/query.sql";
  const query = new SqlQueryModel(async () => parser);
  const initialText = relation
    ? await initialDataViewQuery(source, snapshot, DEFAULT_SQL_AUTHORING_SETTINGS, async () =>
        columnNames(client, relation.schema, relation.name),
      )
    : "";
  await query.setText(initialText);

  const accents = new TableAccents();
  const state: {
    projection: DataViewProjection;
    hidden: string[];
    status: DataViewState["status"];
    message?: string;
    payload?: DataViewState["payload"];
    editability: DataViewState["editability"];
    technical: string[];
    busy: boolean;
    session?: SqlResultSession;
  } = {
    projection: { tables: [], columnTable: [] },
    hidden: [],
    status: "loading",
    editability: { tables: [], columns: [], requiredOrdinals: [], technicalOrdinals: [] },
    technical: [],
    busy: false,
  };
  const seenColumns = new Set<string>();
  // The same pending edits the Extension Host keeps: local until they are written in one
  // transaction. A shell that cannot hold a change cannot show what holding one looks like.
  const edits = new PendingEdits();
  /** What this surface can do so held changes reach PostgreSQL; the sequence itself is shared. */
  const writeHost: DataViewWriteHost = {
    // A write owns the connection it runs on, exactly as a read does.
    openClient: async () => {
      const writer = new Client(connection);
      await writer.connect();
      return writer;
    },
    notify: (message, severity) => emit({ type: "data-view/notice", message, severity }),
    changed: () => broadcast(),
    reload: () => load(),
    serverName: () => serverName,
  };

  const broadcast = () =>
    emit({
      type: "data-view/state",
      state: {
        source,
        serverName,
        query: {
          uri: queryUri,
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
        edits: [...edits.list],
        removedRows: [...edits.removedRows],
        addedRows: [...edits.addedRows],
        busy: state.busy,
        applying: edits.applying,
      },
    });

  const load = async () => {
    state.busy = true;
    broadcast();
    if (query.isEmpty) {
      // A Data View with nothing in it is a legal state: the reader adds the first relation.
      await state.session?.close().catch(() => {});
      state.session = undefined;
      state.payload = undefined;
      state.projection = { tables: [], columnTable: [] };
      state.editability = { tables: [], columns: [], requiredOrdinals: [], technicalOrdinals: [] };
      state.status = "ready";
      state.message = "The query is empty: add a table with +.";
      state.busy = false;
      broadcast();
      return;
    }
    // A cursor owns the connection it reads through, so every load opens its own, exactly as the
    // Extension Host does: the previous one goes with the session it belonged to.
    await state.session?.close().catch(() => {});
    const reader = await connect();
    try {
      const opened = await openDataViewResult({
        client: reader,
        sql: query.effectiveSql(),
        settings: { pageSize: 200, maxCachedRows: 5_000, cursorIdleTimeoutSeconds: 300 },
        binding: { serverId, serverName, database: connection.database },
        accents,
        checkpoint: () => {},
      });
      state.session = opened.session;
      state.payload = opened.session.snapshot();
      state.editability = opened.editability;
      // The query may have composed away the table a held change was written against.
      const forgotten = edits.forget(state.editability);
      if (forgotten > 0)
        emit({
          type: "data-view/notice",
          message: `${countLabel(forgotten, "change")} let go: the query no longer writes to the table ${forgotten === 1 ? "it was" : "they were"} held against.`,
          severity: "info",
        });
      state.projection = opened.projection;
      state.technical = opened.technicalKeys;
      // Identity and relationship columns start hidden when the host says so — including after a
      // JOIN brings new ones in — and whatever the reader chose afterwards is kept.
      if (hideKeyColumns) {
        const fresh = opened.technicalKeys.filter((key) => !seenColumns.has(key));
        if (fresh.length > 0) state.hidden = [...new Set([...state.hidden, ...fresh])];
      }
      for (const key of opened.columnKeys) seenColumns.add(key);
      state.status = "ready";
      state.message = undefined;
    } catch (error) {
      state.status = "error";
      state.message = error instanceof Error ? error.message : String(error);
      await reader.end().catch(() => {});
      // The catalog connection dies with the database; the next load opens a fresh one.
      if (catalogLost) {
        catalogLost = false;
        await client.end().catch(() => {});
        client = await connect(true).catch(() => client);
      }
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

  /**
   * The typed condition lands in a copy of the query that carries the real FROM clause, so the
   * server proposes against the relations the query names — the same trick the extension plays
   * with a hidden document, without a hidden document.
   */
  const filterProposals = async (
    analysis: SqlQueryAnalysis,
    text: string,
    offset: number,
  ): Promise<DataViewCompletion[]> => {
    if (!languageServer) return localFilterCompletions(analysis, text, offset);
    const sentinel = "\u0000";
    const draft = setWhere(query.text, analysis, `${sentinel}${text || " "}`);
    const start = draft.indexOf(sentinel);
    if (start < 0) return localFilterCompletions(analysis, text, offset);
    const candidate = draft.replace(sentinel, "");
    const proposals = await languageServer.complete(
      `${queryUri}.filter`,
      candidate,
      start + Math.min(offset, text.length),
    );
    return proposals.length > 0 ? proposals : localFilterCompletions(analysis, text, offset);
  };

  const compose = async (addition: DataViewAddition, relationChoice?: number) => {
    const outcome = await composeIntoDataViewQuery({
      text: query.text,
      statementEnd: query.analysis?.statement.end ?? 0,
      uri: queryUri,
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
      edits.clear();
      state.hidden = [];
      // Which columns have been seen decides what starts hidden, so a fresh start forgets them.
      seenColumns.clear();
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
          const owning = dataViewRelationOwning(state.projection, request.schema, request.name);
          if (!owning) return;
          await rewrite(query.relationRemoved(owning.table, owning.ownedOrdinals, 2));
          return;
        }
        case "data-view/hide":
          state.hidden = [...state.hidden.filter((key) => key !== request.column), request.column];
          broadcast();
          return;
        case "data-view/technical-columns":
          state.hidden = request.hidden
            ? [...new Set([...state.hidden, ...state.technical])]
            : state.hidden.filter((key) => !state.technical.includes(key));
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
        case "data-view/complete": {
          const analysis = query.analysis;
          emit({
            type: "data-view/completions",
            requestId: request.requestId,
            items: analysis ? await filterProposals(analysis, request.text, request.offset) : [],
          });
          return;
        }
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
        case "data-view/edit": {
          const held = edits.record(request.edit, state.editability);
          if (!held.held) {
            emit({ type: "data-view/notice", message: held.reason, severity: "info" });
            return;
          }
          broadcast();
          return;
        }
        case "data-view/remove-row": {
          if (state.editability.tables.length !== 1) {
            emit({
              type: "data-view/notice",
              message: "The query joins several tables: rows can only be taken away from one.",
              severity: "info",
            });
            return;
          }
          const wasRemoved = edits.isRemoved(request.row);
          edits.toggleRemoval(request.row);
          broadcast();
          // Said when the row is taken, not discovered when the transaction fails.
          const consequences = wasRemoved
            ? []
            : describeDeleteConsequences(state.editability.tables[0] ?? { referencedBy: [] });
          if (consequences.length > 0)
            emit({
              type: "data-view/notice",
              message: consequences.join(" "),
              severity: "info",
            });
          return;
        }
        case "data-view/add-row": {
          const table = state.editability.tables[0];
          if (state.editability.tables.length !== 1 || !table) {
            emit({
              type: "data-view/notice",
              message: "The query joins several tables: rows can only be added to one.",
              severity: "info",
            });
            return;
          }
          edits.addRow(table.tableOid);
          // A reader cannot fill in a column they cannot see.
          state.hidden = withRequiredColumnsRevealed(
            state.hidden,
            state.editability,
            state.projection,
            state.payload?.columns.map((column) => column.name) ?? [],
          );
          broadcast();
          return;
        }
        case "data-view/drop-row":
          edits.dropRow(request.localId);
          broadcast();
          return;
        case "data-view/fill-row":
          edits.fillRow(request.localId, request.column, request.value);
          broadcast();
          return;
        case "data-view/discard":
          edits.clear();
          broadcast();
          return;
        case "data-view/apply":
          // The reader has already been told what happened; the shell has no save of its own.
          await edits.apply(writeHost, state.editability).catch(() => {});
          return;
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
      await languageServer?.dispose().catch(() => {});
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
