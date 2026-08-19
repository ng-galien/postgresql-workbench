import { join } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import type { SyntaxNode, SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import { sqlAuthoringEditStillApplies } from "../../../packages/sql/src/languageServer/composeRequest.js";
import {
  type SqlAuthoringScope,
  sqlAuthoringLanguageStatus,
  sqlAuthoringRejectionAction,
} from "../../../packages/sql/src/languageServer/languageStatus.js";
import {
  decodeSemanticTokenData,
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringPlpgsqlTokensResult,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
} from "../../../packages/sql/src/languageServer/protocol.js";
import { analyzeSqlQuery } from "../../../packages/sql/src/query/analysis.js";
import {
  documentRelations,
  type SqlColumnMention,
  type SqlRelationMention,
  type SqlRoutineMention,
} from "../../../packages/sql/src/query/relations.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  parseSqlAuthoringDrag,
  SQL_AUTHORING_OBJECT_MIME,
  type SqlAuthoringSettings,
} from "../../../packages/sql/src/snapshot.js";
import { canonicalSqlIdentifier } from "../../../packages/sql/src/text/identifiers.js";
import { sqlStatementSlices } from "../../../packages/sql/src/text/sqlLexing.js";
import type { ConnectionManager } from "../connection/index.js";
import { getConnectionName } from "../connection/index.js";
import { PlpgsqlSemanticTokensProvider } from "../plpgsql/index.js";
import {
  resolveScratchpadAssociation,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookMetadata,
} from "../scratchpad/index.js";
import type { WorkbenchIndexController } from "../workbench/index.js";

const SQL_DOCUMENT_SELECTOR = [
  { language: "sql", scheme: "file" },
  { language: "plpgsql", scheme: "file" },
  { language: "sql", scheme: "untitled" },
  { language: "plpgsql", scheme: "untitled" },
  { language: "plpgsql", scheme: "vscode-notebook-cell" },
  { language: "sql", scheme: "postgresql-workbench-data-sql" },
] as const;
const SQL_AUTHORING_LANGUAGE_STATUS_ID = "postgresql-workbench.sqlAuthoring";
const REVEAL_SQL_REFERENCE_COMMAND = "postgresql-workbench.revealSqlReference";
export const REFRESH_SQL_AUTHORING_CONTEXT_COMMAND =
  "postgresql-workbench.refreshSqlAuthoringContext";

export interface SqlAuthoringNavigationTarget {
  column?: string;
  database: string;
  oid: number;
  serverId: string;
}

/** The running SQL authoring server: every consumer composes through it, never through the engine. */
export interface SqlAuthoringRegistration extends vscode.Disposable {
  compose(
    request: SqlAuthoringComposeRequest,
    token?: vscode.CancellationToken,
  ): Promise<SqlAuthoringComposeResult>;
}

export async function registerSqlAuthoring(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  index: WorkbenchIndexController,
  navigate?: (target: SqlAuthoringNavigationTarget) => Promise<boolean>,
  documentAssociation?: (uri: string) => string | undefined,
): Promise<SqlAuthoringRegistration> {
  const module = context.asAbsolutePath(join("dist", "sql-authoring-server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc },
  };
  const plpgsqlSemanticTokens = new PlpgsqlSemanticTokensProvider(() => index.syntaxParser());
  const clientOptions: LanguageClientOptions = {
    documentSelector: [...SQL_DOCUMENT_SELECTOR],
    outputChannelName: "PostgreSQL Workbench SQL Authoring",
  };
  const client = new LanguageClient(
    "postgresql-workbench-sql-authoring",
    "PostgreSQL Workbench SQL Authoring",
    serverOptions,
    clientOptions,
  );

  client.onRequest(
    SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
    async ({ uri }: { uri: string }): Promise<SqlAuthoringPlpgsqlTokensResult> => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri,
      );
      if (!document) return { tokens: [] };
      try {
        const tokens = await plpgsqlSemanticTokens.provideDocumentSemanticTokens(document);
        return { tokens: decodeSemanticTokenData(tokens.data) };
      } catch {
        return { tokens: [] };
      }
    },
  );
  client.onRequest<SqlAuthoringDocumentContext, never>(
    SQL_AUTHORING_CONTEXT_REQUEST,
    (parameters) =>
      resolveDocumentContext(
        (parameters as { uri: string }).uri,
        connections,
        index,
        documentAssociation,
      ),
  );
  client.onRequest(
    SQL_AUTHORING_SYNTAX_REQUEST,
    async ({
      uri,
      source,
      caret,
    }: {
      uri: string;
      source: string;
      /** Offset being typed: a placeholder is inserted there so an unfinished statement parses. */
      caret?: number;
    }): Promise<SqlAuthoringSyntaxResult> => {
      const parser = await index.syntaxParser();
      const settings = resolveSqlAuthoringSettings(uri);
      const {
        source: parsedSource,
        relations,
        caretRole,
      } = await documentRelations(parser, source, {
        uri,
        maxDepth: settings.syntaxMaxDepth,
        maxNodes: settings.syntaxMaxNodes,
        ...(caret === undefined ? {} : { caret }),
      });
      const budget = {
        source: parsedSource,
        uri,
        maxDepth: settings.syntaxMaxDepth,
        maxNodes: settings.syntaxMaxNodes,
        namedOnly: true,
      };
      const syntax = await parser.parse({ language: "sql", ...budget });
      if (!syntax.hasError || syntax.truncated) {
        // The composition engine rewrites from this analysis; it never scans the text itself.
        const analyzed = syntax.truncated
          ? undefined
          : await analyzeSqlQuery(source, parser, {
              uri,
              maxDepth: settings.syntaxMaxDepth,
              maxNodes: settings.syntaxMaxNodes,
            });
        return {
          hasError: syntax.hasError,
          truncated: syntax.truncated,
          ...(analyzed?.status === "ok" ? { analysis: analyzed.analysis } : {}),
          ...(analyzed?.shape === undefined ? {} : { shape: analyzed.shape }),
          relations,
          ...(caretRole === undefined ? {} : { caretRole }),
        };
      }
      const languageId = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri,
      )?.languageId;
      const plpgsqlBody =
        languageId === "plpgsql" &&
        !(await parser.parse({ language: "plpgsql", ...budget })).hasError;
      const errorLine = firstSyntaxErrorLine(syntax.root);
      return {
        hasError: true,
        truncated: false,
        ...(errorLine === undefined ? {} : { errorLine }),
        ...(plpgsqlBody ? { plpgsqlBody } : {}),
        relations,
        ...(caretRole === undefined ? {} : { caretRole }),
      };
    },
  );
  client.onRequest<SqlAuthoringSettings, never>(SQL_AUTHORING_SETTINGS_REQUEST, (parameters) =>
    resolveSqlAuthoringSettings((parameters as { uri: string }).uri),
  );
  await client.start();

  const languageStatus = vscode.languages.createLanguageStatusItem(
    SQL_AUTHORING_LANGUAGE_STATUS_ID,
    [...SQL_DOCUMENT_SELECTOR] satisfies vscode.DocumentSelector,
  );
  languageStatus.name = "PostgreSQL Workbench SQL authoring";
  const updateLanguageStatus = () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    const uri = document.uri.toString();
    const context = resolveDocumentContext(uri, connections, index, documentAssociation);
    const scope = sqlAuthoringScope(uri);
    const status = sqlAuthoringLanguageStatus({
      context,
      documentUri: uri,
      scope,
      connexionName: sqlAuthoringConnexionName(uri, context, connections, documentAssociation),
    });
    languageStatus.text = status.text;
    languageStatus.detail = status.detail;
    languageStatus.severity =
      status.severity === "warning"
        ? vscode.LanguageStatusSeverity.Warning
        : vscode.LanguageStatusSeverity.Information;
    languageStatus.command = status.command;
  };
  updateLanguageStatus();

  const dropProvider = vscode.languages.registerDocumentDropEditProvider(
    [...SQL_DOCUMENT_SELECTOR] satisfies vscode.DocumentSelector,
    {
      async provideDocumentDropEdits(document, position, transfer, token) {
        const item = transfer.get(SQL_AUTHORING_OBJECT_MIME);
        if (!item) return undefined;
        const payload = parseSqlAuthoringDrag(await item.asString());
        if (!payload || token.isCancellationRequested) return undefined;
        let request: SqlAuthoringComposeRequest = {
          uri: document.uri.toString(),
          text: document.getText(),
          offset: document.offsetAt(position),
          payload,
        };
        let result = await client.sendRequest<SqlAuthoringComposeResult>(
          SQL_AUTHORING_COMPOSE_REQUEST,
          request,
          token,
        );
        if (token.isCancellationRequested) return undefined;
        if (result.status === "ambiguous") {
          const current = resolveDocumentContext(
            document.uri.toString(),
            connections,
            index,
            documentAssociation,
          );
          if (!sqlAuthoringContextMatchesToken(current, result.snapshot)) {
            void vscode.window.showWarningMessage(
              "The Workbench Index changed while composing SQL. Retry the drop on the fresh snapshot.",
            );
            return unchangedDropEdit("Leave stale SQL composition unchanged");
          }
          const selected = await vscode.window.showQuickPick(
            result.choices.map((choice) => ({ ...choice, detail: choice.description })),
            {
              title: result.title ?? "Choose the foreign key for this JOIN",
              placeHolder: result.placeHolder ?? "No JOIN is added until you choose",
            },
          );
          if (!selected) return unchangedDropEdit("Leave SQL unchanged");
          request = { ...request, relationChoice: selected.index };
          result = await client.sendRequest<SqlAuthoringComposeResult>(
            SQL_AUTHORING_COMPOSE_REQUEST,
            request,
            token,
          );
        }
        if (result.status === "rejected") {
          const documentUri = document.uri.toString();
          const action = sqlAuthoringRejectionAction(
            result.reason,
            documentUri,
            sqlAuthoringScope(documentUri),
          );
          void vscode.window
            .showWarningMessage(result.message, ...(action ? [action.title] : []))
            .then((choice) => {
              if (action && choice === action.title) {
                void vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
              }
            });
          return unchangedDropEdit("Leave unsupported SQL unchanged");
        }
        if (result.status !== "edit") return unchangedDropEdit("Leave SQL unchanged");
        const current = resolveDocumentContext(
          document.uri.toString(),
          connections,
          index,
          documentAssociation,
        );
        if (!sqlAuthoringEditStillApplies(result, current, request.text, document.getText())) {
          void vscode.window.showWarningMessage(
            "The Workbench Index or SQL document changed while composing. Retry the drop.",
          );
          return unchangedDropEdit("Leave changed SQL unchanged");
        }
        const edit = new vscode.DocumentDropEdit("", result.title);
        edit.additionalEdit = new vscode.WorkspaceEdit();
        edit.additionalEdit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          result.text,
        );
        return edit;
      },
    },
    { dropMimeTypes: [SQL_AUTHORING_OBJECT_MIME] },
  );

  const hovers = vscode.languages.registerHoverProvider(
    [...SQL_DOCUMENT_SELECTOR] satisfies vscode.DocumentSelector,
    {
      async provideHover(document, position) {
        const context = resolveDocumentContext(
          document.uri.toString(),
          connections,
          index,
          documentAssociation,
        );
        if (context.status !== "available" || context.snapshot.status !== "available") return;
        const references = await sqlReferences(
          document,
          context.snapshot,
          await index.syntaxParser(),
          resolveSqlAuthoringSettings(document.uri.toString()),
        );
        const reference = references.find(({ range }) => range.contains(position));
        if (!reference) return;
        const command = `command:${REVEAL_SQL_REFERENCE_COMMAND}?${encodeURIComponent(
          JSON.stringify([reference.target]),
        )}`;
        const markdown = new vscode.MarkdownString(
          `**${reference.label}**\n\n[Reveal in Workbench Sources](${command})`,
        );
        markdown.isTrusted = { enabledCommands: [REVEAL_SQL_REFERENCE_COMMAND] };
        return new vscode.Hover(markdown, reference.range);
      },
    },
  );
  const revealReference = vscode.commands.registerCommand(
    REVEAL_SQL_REFERENCE_COMMAND,
    async (target: SqlAuthoringNavigationTarget) => {
      if (!navigate || !(await navigate(target))) {
        void vscode.window.showWarningMessage(
          "This PostgreSQL reference is no longer available in this Connexion's Workbench Sources.",
        );
      }
    },
  );
  const refreshSemanticTokens = () => {
    void client.sendNotification(SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED).catch(() => undefined);
    updateLanguageStatus();
  };
  const refreshContext = vscode.commands.registerCommand(
    REFRESH_SQL_AUTHORING_CONTEXT_COMMAND,
    refreshSemanticTokens,
  );
  const semanticTokenRefreshSubscriptions = vscode.Disposable.from(
    index.onDidChangeState(refreshSemanticTokens),
    connections.onServerChanged(refreshSemanticTokens),
    connections.onChanged(updateLanguageStatus),
    vscode.window.onDidChangeActiveTextEditor(updateLanguageStatus),
    vscode.window.onDidChangeActiveNotebookEditor(updateLanguageStatus),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.notebookType === SQL_NOTEBOOK_TYPE && event.metadata !== undefined) {
        refreshSemanticTokens();
      }
    }),
  );

  const subscriptions = vscode.Disposable.from(
    dropProvider,
    hovers,
    revealReference,
    refreshContext,
    languageStatus,
    semanticTokenRefreshSubscriptions,
    {
      dispose: () => void client.stop(),
    },
  );
  return {
    dispose: () => subscriptions.dispose(),
    compose: (request, token) =>
      token
        ? client.sendRequest<SqlAuthoringComposeResult>(
            SQL_AUTHORING_COMPOSE_REQUEST,
            request,
            token,
          )
        : client.sendRequest<SqlAuthoringComposeResult>(SQL_AUTHORING_COMPOSE_REQUEST, request),
  };
}

interface SqlReference {
  label: string;
  range: vscode.Range;
  target: SqlAuthoringNavigationTarget;
}

export async function sqlReferences(
  document: vscode.TextDocument,
  snapshot: Extract<SqlAuthoringDocumentContext, { status: "available" }>["snapshot"],
  parser: SyntaxParser,
  settings: SqlAuthoringSettings = DEFAULT_SQL_AUTHORING_SETTINGS,
): Promise<SqlReference[]> {
  const source = document.getText();
  const { relations, columns, routines } = await documentRelations(parser, source, {
    uri: document.uri.toString(),
    maxDepth: settings.syntaxMaxDepth,
    maxNodes: settings.syntaxMaxNodes,
  });
  const references: SqlReference[] = [];
  // Aliases are scoped to their Statement: the same name may denote another relation further down.
  for (const statement of sqlStatementSlices(source)) {
    const within = <T extends { nameRange: { start: number; end: number } }>(
      mentions: readonly T[],
    ) =>
      mentions.filter(
        (mention) =>
          mention.nameRange.start >= statement.start && mention.nameRange.end <= statement.end,
      );
    references.push(
      ...statementReferences(
        document,
        snapshot,
        within(relations),
        within(columns),
        within(routines),
      ),
    );
  }
  return references;
}

/** References of one Statement, with its own alias scope. */
function statementReferences(
  document: vscode.TextDocument,
  snapshot: Extract<SqlAuthoringDocumentContext, { status: "available" }>["snapshot"],
  relations: readonly SqlRelationMention[],
  columns: readonly SqlColumnMention[],
  routines: readonly SqlRoutineMention[],
): SqlReference[] {
  const references: SqlReference[] = [];
  const aliases = new Map<string, (typeof snapshot.objects)[number]>();
  for (const relation of relations) {
    if (relation.schema === undefined) continue;
    // A relation position names a table or a view; only when no relation carries that name does
    // it name a routine, as in `CALL shop.move_inventory(…)`. Homonyms resolve to the relation.
    const named = snapshot.objects.filter(
      (candidate) =>
        candidate.schema === canonicalSqlIdentifier(relation.schema ?? "") &&
        candidate.name === canonicalSqlIdentifier(relation.name),
    );
    const object =
      named.find((candidate) => candidate.kind === "table" || candidate.kind === "view") ??
      named.find((candidate) => candidate.kind === "function" || candidate.kind === "procedure");
    if (!object) continue;
    const nameLength = relation.name.length;
    references.push(
      sqlReference(document, relation.nameRange.end - nameLength, nameLength, object),
    );
    if (object.kind === "table" || object.kind === "view") {
      aliases.set(canonicalSqlIdentifier(relation.reference), object);
    }
  }
  for (const routine of routines) {
    if (routine.schema === undefined) continue;
    const object = snapshot.objects.find(
      (candidate) =>
        (candidate.kind === "function" || candidate.kind === "procedure") &&
        candidate.schema === canonicalSqlIdentifier(routine.schema ?? "") &&
        candidate.name === canonicalSqlIdentifier(routine.name),
    );
    if (!object) continue;
    references.push(
      sqlReference(
        document,
        routine.nameRange.start,
        routine.nameRange.end - routine.nameRange.start,
        object,
      ),
    );
  }
  for (const column of columns) {
    const name = canonicalSqlIdentifier(column.name);
    const owner =
      column.qualifier === undefined
        ? soleOwnerOf(name, aliases)
        : aliases.get(canonicalSqlIdentifier(column.qualifier));
    if (!owner?.columns.some((candidate) => candidate.name === name)) continue;
    references.push(
      sqlReference(
        document,
        column.nameRange.start,
        column.nameRange.end - column.nameRange.start,
        owner,
        name,
      ),
    );
  }
  return references;
}

/** The only relation of the query that has this column, when exactly one does. */
function soleOwnerOf<T extends { oid: number; columns: readonly { name: string }[] }>(
  name: string,
  aliases: ReadonlyMap<string, T>,
): T | undefined {
  const owners = new Map(
    [...aliases.values()]
      .filter((object) => object.columns.some((column) => column.name === name))
      .map((object) => [object.oid, object]),
  );
  return owners.size === 1 ? [...owners.values()][0] : undefined;
}

function sqlReference(
  document: vscode.TextDocument,
  offset: number,
  length: number,
  object: { database: string; name: string; oid: number; schema: string; serverId: string },
  column?: string,
): SqlReference {
  const target: SqlAuthoringNavigationTarget = {
    column,
    database: object.database,
    oid: object.oid,
    serverId: object.serverId,
  };
  return {
    label: column ? `${object.schema}.${object.name}.${column}` : `${object.schema}.${object.name}`,
    range: new vscode.Range(document.positionAt(offset), document.positionAt(offset + length)),
    target,
  };
}

export function resolveSqlAuthoringSettings(uri?: string): SqlAuthoringSettings {
  const parsedUri = uri === undefined ? undefined : vscode.Uri.parse(uri);
  const document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === uri,
  );
  const scope: vscode.ConfigurationScope | undefined =
    document ??
    (parsedUri
      ? {
          uri: parsedUri,
          languageId: parsedUri.scheme === "vscode-notebook-cell" ? "plpgsql" : "sql",
        }
      : undefined);
  const tabSize = vscode.workspace
    .getConfiguration("editor", scope)
    .get<number>("tabSize", DEFAULT_SQL_AUTHORING_SETTINGS.tabSize);
  const configuredAliasStyle = vscode.workspace
    .getConfiguration("postgresql-workbench.sqlAuthoring", scope)
    .get<string>("aliasStyle", DEFAULT_SQL_AUTHORING_SETTINGS.aliasStyle);
  const syntaxMaxDepth = vscode.workspace
    .getConfiguration("postgresql-workbench.sqlAuthoring", scope)
    .get<number>("syntaxMaxDepth", DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxDepth);
  const syntaxMaxNodes = vscode.workspace
    .getConfiguration("postgresql-workbench.sqlAuthoring", scope)
    .get<number>("syntaxMaxNodes", DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxNodes);
  return {
    tabSize:
      Number.isInteger(tabSize) && tabSize >= 1 && tabSize <= 8
        ? tabSize
        : DEFAULT_SQL_AUTHORING_SETTINGS.tabSize,
    aliasStyle:
      configuredAliasStyle === "initial" || configuredAliasStyle === "initialWithOrdinal"
        ? "initial"
        : "fullName",
    syntaxMaxDepth: positiveIntegerOr(
      syntaxMaxDepth,
      DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxDepth,
    ),
    syntaxMaxNodes: positiveIntegerOr(
      syntaxMaxNodes,
      DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxNodes,
    ),
  };
}

function positiveIntegerOr(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function unchangedDropEdit(title: string): vscode.DocumentDropEdit {
  return new vscode.DocumentDropEdit("", title);
}

export function resolveDocumentContext(
  uri: string,
  connections: Pick<ConnectionManager, "servers">,
  index: Pick<WorkbenchIndexController, "sqlAuthoringSnapshot">,
  documentAssociation?: (uri: string) => string | undefined,
): SqlAuthoringDocumentContext {
  const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
    candidate.getCells().some((cell) => cell.document.uri.toString() === uri),
  );
  const isNotebookCell = vscode.Uri.parse(uri).scheme === "vscode-notebook-cell";
  if (notebook || isNotebookCell) {
    if (!notebook) {
      return {
        status: "unavailable",
        message: "This notebook cell is not attached to a PostgreSQL Workbench Scratchpad.",
      };
    }
    if (notebook.notebookType !== SQL_NOTEBOOK_TYPE) {
      return {
        status: "unavailable",
        message: "SQL authoring for notebook cells is limited to PostgreSQL Workbench Scratchpads.",
      };
    }
    const association = resolveScratchpadAssociation(
      sqlNotebookMetadata(notebook.metadata),
      connections.servers,
    );
    if (association.status === "unassociated") {
      return { status: "unassociated", message: "This Scratchpad has no Association." };
    }
    if (association.status === "unavailable") {
      return {
        status: "unavailable",
        message: "This Scratchpad Association is no longer available.",
      };
    }
    return indexedContext(
      index,
      association.snapshot.serverId,
      association.snapshot.database,
      "Scratchpad Association",
    );
  }

  if (documentAssociation) {
    const serverId = documentAssociation(uri);
    if (!serverId) {
      return { status: "unassociated", message: "This SQL document has no Association." };
    }
    const server = connections.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      return { status: "unavailable", message: "This SQL Document Association is unavailable." };
    }
    return indexedContext(index, server.id, server.database, "SQL Document Association");
  }
  return { status: "unassociated", message: "This SQL document has no Association." };
}

function sqlAuthoringScope(uri: string): SqlAuthoringScope {
  return vscode.Uri.parse(uri).scheme === "vscode-notebook-cell" ? "scratchpad" : "document";
}

function sqlAuthoringConnexionName(
  uri: string,
  context: SqlAuthoringDocumentContext,
  connections: Pick<ConnectionManager, "servers">,
  documentAssociation?: (uri: string) => string | undefined,
): string | undefined {
  const serverId =
    context.status === "available"
      ? context.snapshot.serverId
      : vscode.Uri.parse(uri).scheme === "vscode-notebook-cell"
        ? undefined
        : documentAssociation?.(uri);
  return serverId
    ? (() => {
        const server = connections.servers.find((candidate) => candidate.id === serverId);
        return server ? getConnectionName(server) : undefined;
      })()
    : undefined;
}

function firstSyntaxErrorLine(node: SyntaxNode): number | undefined {
  if (node.error || node.missing) return node.start.line;
  for (const child of node.children) {
    const line = firstSyntaxErrorLine(child);
    if (line !== undefined) return line;
  }
  return undefined;
}

function indexedContext(
  index: Pick<WorkbenchIndexController, "sqlAuthoringSnapshot">,
  serverId: string,
  database: string,
  label: string,
): SqlAuthoringDocumentContext {
  const snapshot = index.sqlAuthoringSnapshot({ serverId, database });
  return snapshot
    ? { status: "available", snapshot }
    : { status: "not-indexed", message: `The ${label} is not indexed.` };
}

function sqlNotebookMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return {
    serverId: typeof metadata.serverId === "string" ? metadata.serverId : undefined,
    serverName: typeof metadata.serverName === "string" ? metadata.serverName : undefined,
    database: typeof metadata.database === "string" ? metadata.database : undefined,
    executionMode: metadata.executionMode === "manual" ? "manual" : "auto",
  };
}

/** The syntax budget the analysis of a SQL document is allowed to spend. */
export function sqlSyntaxAnalysisBudget() {
  const settings = resolveSqlAuthoringSettings();
  return { maxDepth: settings.syntaxMaxDepth, maxNodes: settings.syntaxMaxNodes };
}
