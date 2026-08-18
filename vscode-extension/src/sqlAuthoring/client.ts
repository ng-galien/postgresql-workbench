import { join } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import type { SyntaxNode } from "../../../src/analysis/syntaxTree.js";
import type { ConnectionManager } from "../connectionManager.js";
import { PlpgsqlSemanticTokensProvider } from "../plpgsqlSemanticTokens.js";
import { getConnectionName } from "../serverStore.js";
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
  type SqlAuthoringScope,
  sqlAuthoringLanguageStatus,
  sqlAuthoringRejectionAction,
} from "./languageStatus.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  decodeSemanticTokenData,
  parseSqlAuthoringDrag,
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_OBJECT_MIME,
  SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringPlpgsqlTokensResult,
  type SqlAuthoringSettings,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
} from "./protocol.js";
import { postgresPlpgsqlRanges, scanPostgresSql } from "./sqlLexing.js";

const SQL_DOCUMENT_SELECTOR = [
  { language: "sql", scheme: "file" },
  { language: "plpgsql", scheme: "file" },
  { language: "sql", scheme: "untitled" },
  { language: "plpgsql", scheme: "untitled" },
  { language: "plpgsql", scheme: "vscode-notebook-cell" },
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

export async function registerSqlAuthoring(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  index: WorkbenchIndexController,
  navigate?: (target: SqlAuthoringNavigationTarget) => Promise<boolean>,
  documentAssociation?: (uri: string) => string | undefined,
): Promise<vscode.Disposable> {
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
    async ({ uri, source }: { uri: string; source: string }): Promise<SqlAuthoringSyntaxResult> => {
      const parser = await index.syntaxParser();
      const settings = resolveSqlAuthoringSettings(uri);
      const budget = {
        source,
        uri,
        maxDepth: settings.syntaxMaxDepth,
        maxNodes: settings.syntaxMaxNodes,
        namedOnly: true,
      };
      const syntax = await parser.parse({ language: "sql", ...budget });
      if (!syntax.hasError || syntax.truncated) {
        return { hasError: syntax.hasError, truncated: syntax.truncated };
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
      provideHover(document, position) {
        const context = resolveDocumentContext(
          document.uri.toString(),
          connections,
          index,
          documentAssociation,
        );
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

  return vscode.Disposable.from(
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
  for (const range of postgresPlpgsqlRanges(source)) {
    references.push(
      ...sqlStatementReferences(
        document,
        source.slice(range.start, range.end),
        range.start,
        snapshot,
      ),
    );
  }
  return references;
}

function sqlStatementReferences(
  document: vscode.TextDocument,
  source: string,
  documentOffset: number,
  snapshot: Extract<SqlAuthoringDocumentContext, { status: "available" }>["snapshot"],
): SqlReference[] {
  const maskedSource = scanPostgresSql(source).maskedSource;
  const identifier = POSTGRES_IDENTIFIER_PATTERN;
  const relationPattern = new RegExp(
    String.raw`\b(?:FROM|INTO|UPDATE|USING|(?:NATURAL\s+)?(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|(?:INNER|CROSS)\s+)?JOIN)\s+(${identifier}\.${identifier})`,
    "giu",
  );
  const aliases = new Map<string, (typeof snapshot.objects)[number]>();
  const references: SqlReference[] = [];
  for (const match of maskedSource.matchAll(relationPattern)) {
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
    const alias = sqlAliasAfterRelation(source, maskedSource, relationOffset + match[1].length);
    aliases.set(canonicalSqlIdentifier(alias ?? parts[1]), object);
  }

  const routinePattern = new RegExp(
    String.raw`\b(?:CALL\s+)?(${identifier}\.${identifier})\s*(?=\()`,
    "giu",
  );
  for (const match of maskedSource.matchAll(routinePattern)) {
    const routineOffset = (match.index ?? 0) + match[0].indexOf(match[1]);
    const routineReference = source.slice(routineOffset, routineOffset + match[1].length);
    const parts = splitSqlQualifiedIdentifier(routineReference);
    if (parts.length !== 2) continue;
    const object = snapshot.objects.find(
      (candidate) =>
        (candidate.kind === "function" || candidate.kind === "procedure") &&
        candidate.schema === canonicalSqlIdentifier(parts[0]) &&
        candidate.name === canonicalSqlIdentifier(parts[1]),
    );
    if (!object) continue;
    const nameOffset = routineOffset + routineReference.lastIndexOf(parts[1]);
    references.push(sqlReference(document, documentOffset + nameOffset, parts[1].length, object));
  }

  const qualified = new RegExp(String.raw`(${identifier})\s*\.\s*(${identifier})`, "gu");
  for (const match of maskedSource.matchAll(qualified)) {
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
  const unqualified = new RegExp(identifier, "gu");
  for (const match of maskedSource.matchAll(unqualified)) {
    const offset = match.index ?? 0;
    if (hasAdjacentDot(source, offset, match[0].length)) continue;
    const name = canonicalSqlIdentifier(source.slice(offset, offset + match[0].length));
    const owners = new Map(
      [...aliases.values()]
        .filter((object) => object.columns.some((column) => column.name === name))
        .map((object) => [object.oid, object]),
    );
    if (owners.size !== 1) continue;
    const object = [...owners.values()][0];
    references.push(sqlReference(document, documentOffset + offset, match[0].length, object, name));
  }
  return references;
}

function hasAdjacentDot(source: string, offset: number, length: number): boolean {
  let before = offset - 1;
  while (before >= 0 && /\s/u.test(source[before])) before -= 1;
  if (source[before] === ".") return true;
  let after = offset + length;
  while (after < source.length && /\s/u.test(source[after])) after += 1;
  return source[after] === ".";
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
