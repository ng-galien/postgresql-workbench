import { join } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import type { ConnectionManager } from "../connectionManager.js";
import { PlpgsqlSemanticTokensProvider } from "../plpgsqlSemanticTokens.js";
import {
  resolveScratchpadAssociation,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookMetadata,
} from "../sqlNotebookModel.js";
import type { WorkbenchIndexController } from "../workbenchIndexController.js";
import { sqlAuthoringEditStillApplies } from "./composeRequest.js";
import {
  canonicalSqlIdentifier,
  POSTGRES_IDENTIFIER_PATTERN,
  splitSqlQualifiedIdentifier,
  sqlAliasAfterRelation,
} from "./identifiers.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  parseSqlAuthoringDrag,
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_OBJECT_MIME,
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSettings,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
} from "./protocol.js";
import { scanPostgresSql } from "./sqlLexing.js";

const SQL_DOCUMENT_SELECTOR = [
  { language: "sql", scheme: "file" },
  { language: "plpgsql", scheme: "file" },
  { language: "plpgsql", scheme: "vscode-notebook-cell" },
] as const;
const REVEAL_SQL_REFERENCE_COMMAND = "postgresql-workbench.revealSqlReference";

export interface SqlAuthoringNavigationTarget {
  column?: string;
  database: string;
  oid: number;
  serverId: string;
}

export async function registerSqlAuthoring(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  index: WorkbenchIndexController,
  navigate?: (target: SqlAuthoringNavigationTarget) => Promise<boolean>,
): Promise<vscode.Disposable> {
  const module = context.asAbsolutePath(join("dist", "sql-authoring-server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc },
  };
  const plpgsqlSemanticTokens = new PlpgsqlSemanticTokensProvider(() => index.syntaxParser());
  const clientOptions: LanguageClientOptions = {
    documentSelector: [...SQL_DOCUMENT_SELECTOR],
    middleware: {
      provideDocumentSemanticTokens(document, token, next) {
        if (document.languageId === "plpgsql" && document.uri.scheme === "file") {
          return plpgsqlSemanticTokens.provideDocumentSemanticTokens(document);
        }
        return next(document, token);
      },
    },
    outputChannelName: "PostgreSQL Workbench SQL Authoring",
  };
  const client = new LanguageClient(
    "postgresql-workbench-sql-authoring",
    "PostgreSQL Workbench SQL Authoring",
    serverOptions,
    clientOptions,
  );
  await client.start();

  client.onRequest<SqlAuthoringDocumentContext, never>(
    SQL_AUTHORING_CONTEXT_REQUEST,
    (parameters) => resolveDocumentContext((parameters as { uri: string }).uri, connections, index),
  );
  client.onRequest(
    SQL_AUTHORING_SYNTAX_REQUEST,
    async ({ uri, source }: { uri: string; source: string }): Promise<SqlAuthoringSyntaxResult> => {
      const parser = await index.syntaxParser();
      const settings = resolveSqlAuthoringSettings(uri);
      const syntax = await parser.parse({
        language: "sql",
        source,
        uri,
        maxDepth: settings.syntaxMaxDepth,
        maxNodes: settings.syntaxMaxNodes,
        namedOnly: true,
      });
      return { hasError: syntax.hasError, truncated: syntax.truncated };
    },
  );
  client.onRequest<SqlAuthoringSettings, never>(SQL_AUTHORING_SETTINGS_REQUEST, (parameters) =>
    resolveSqlAuthoringSettings((parameters as { uri: string }).uri),
  );

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
          const current = resolveDocumentContext(document.uri.toString(), connections, index);
          if (!sqlAuthoringContextMatchesToken(current, result.snapshot)) {
            void vscode.window.showWarningMessage(
              "The Workbench Index changed while composing SQL. Retry the drop on the fresh snapshot.",
            );
            return unchangedDropEdit("Leave stale SQL composition unchanged");
          }
          const selected = await vscode.window.showQuickPick(
            result.choices.map((choice) => ({ ...choice, detail: choice.description })),
            {
              title: "Choose the foreign key for this JOIN",
              placeHolder: "No JOIN is added until you choose",
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
          void vscode.window.showWarningMessage(result.message);
          return unchangedDropEdit("Leave unsupported SQL unchanged");
        }
        if (result.status !== "edit") return unchangedDropEdit("Leave SQL unchanged");
        const current = resolveDocumentContext(document.uri.toString(), connections, index);
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
      provideHover(document, position) {
        const context = resolveDocumentContext(document.uri.toString(), connections, index);
        if (context.status !== "available" || context.snapshot.status !== "available") return;
        const reference = sqlReferences(document, context.snapshot).find(({ range }) =>
          range.contains(position),
        );
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
          "This PostgreSQL reference is no longer available in the active Workbench Sources.",
        );
      }
    },
  );
  const refreshSemanticTokens = () => {
    void client.sendNotification(SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED).catch(() => undefined);
  };
  const semanticTokenRefreshSubscriptions = vscode.Disposable.from(
    index.onDidChangeState(refreshSemanticTokens),
    connections.onServerChanged(refreshSemanticTokens),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.notebookType === SQL_NOTEBOOK_TYPE && event.metadata !== undefined) {
        refreshSemanticTokens();
      }
    }),
  );

  return vscode.Disposable.from(
    dropProvider,
    hovers,
    revealReference,
    semanticTokenRefreshSubscriptions,
    {
      dispose: () => void client.stop(),
    },
  );
}

interface SqlReference {
  label: string;
  range: vscode.Range;
  target: SqlAuthoringNavigationTarget;
}

export function sqlReferences(
  document: vscode.TextDocument,
  snapshot: Extract<SqlAuthoringDocumentContext, { status: "available" }>["snapshot"],
): SqlReference[] {
  const source = document.getText();
  const separators = scanPostgresSql(source).statementSeparators;
  const boundaries = [...separators.map((offset) => offset + 1), source.length];
  const references: SqlReference[] = [];
  let start = 0;
  for (const end of boundaries) {
    references.push(...sqlStatementReferences(document, source.slice(start, end), start, snapshot));
    start = end;
  }
  return references;
}

function sqlStatementReferences(
  document: vscode.TextDocument,
  source: string,
  documentOffset: number,
  snapshot: Extract<SqlAuthoringDocumentContext, { status: "available" }>["snapshot"],
): SqlReference[] {
  const topLevelSource = scanPostgresSql(source).topLevelSource;
  const identifier = POSTGRES_IDENTIFIER_PATTERN;
  const relationPattern = new RegExp(
    String.raw`\b(?:FROM|(?:NATURAL\s+)?(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|(?:INNER|CROSS)\s+)?JOIN)\s+(${identifier}\.${identifier})`,
    "giu",
  );
  const aliases = new Map<string, (typeof snapshot.objects)[number]>();
  const references: SqlReference[] = [];
  for (const match of topLevelSource.matchAll(relationPattern)) {
    const relationOffset = (match.index ?? 0) + match[0].indexOf(match[1]);
    const relation = source.slice(relationOffset, relationOffset + match[1].length);
    const parts = splitSqlQualifiedIdentifier(relation);
    if (parts.length !== 2) continue;
    const object = snapshot.objects.find(
      (candidate) =>
        (candidate.kind === "table" || candidate.kind === "view") &&
        candidate.schema === canonicalSqlIdentifier(parts[0]) &&
        candidate.name === canonicalSqlIdentifier(parts[1]),
    );
    if (!object) continue;
    const nameOffset = relationOffset + relation.lastIndexOf(parts[1]);
    references.push(sqlReference(document, documentOffset + nameOffset, parts[1].length, object));
    const alias = sqlAliasAfterRelation(source, topLevelSource, relationOffset + match[1].length);
    aliases.set(canonicalSqlIdentifier(alias ?? parts[1]), object);
  }

  const qualified = new RegExp(String.raw`(${identifier})\s*\.\s*(${identifier})`, "gu");
  for (const match of topLevelSource.matchAll(qualified)) {
    const matchOffset = match.index ?? 0;
    const ownerOffset = matchOffset + match[0].indexOf(match[1]);
    const columnOffset = matchOffset + match[0].lastIndexOf(match[2]);
    const owner = source.slice(ownerOffset, ownerOffset + match[1].length);
    const column = source.slice(columnOffset, columnOffset + match[2].length);
    const object = aliases.get(canonicalSqlIdentifier(owner));
    const columnName = canonicalSqlIdentifier(column);
    if (!object?.columns.some((candidate) => candidate.name === columnName)) continue;
    references.push(
      sqlReference(document, documentOffset + columnOffset, match[2].length, object, columnName),
    );
  }
  return references;
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
  connections: Pick<ConnectionManager, "activeServer" | "isConnected" | "servers">,
  index: Pick<WorkbenchIndexController, "sqlAuthoringSnapshot">,
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

  const active = connections.activeServer;
  if (!active || !connections.isConnected) {
    return { status: "unavailable", message: "No active DatabaseContext is connected." };
  }
  return indexedContext(index, active.id, active.database, "active DatabaseContext");
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
