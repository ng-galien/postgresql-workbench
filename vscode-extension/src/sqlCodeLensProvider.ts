import * as vscode from "vscode";
import { UnusableSyntaxTreeError } from "../../src/analysis/syntaxNodes.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import type { FunctionDefinition, ParsedCallSite } from "../../src/callParser.js";
import { parseSqlFileStrict } from "../../src/callParser.js";
import { CODE_MONIKER_URI_SCHEME } from "./codeMonikerUri.js";
import { sqlStatementSlices } from "./sqlAuthoring/sqlLexing.js";
import {
  type SqlDebugAvailability,
  type SqlDebugUnavailableReason,
  shouldProvideSqlCodeLenses,
} from "./sqlCodeLensPolicy.js";

export type { FunctionDefinition, ParsedCallSite as CallSite };
export interface CommandFunctionDefinition extends FunctionDefinition {
  serverId?: string;
  oid?: number;
  symbolUri?: string;
  documentUri?: string;
  documentVersion?: number;
}

export interface CommandCallSite extends ParsedCallSite {
  serverId?: string;
  documentUri?: string;
}

export interface CommandSqlStatement {
  documentUri: string;
  line: number;
  sql: string;
}

export interface DocumentConnectionTarget {
  documentUri: string;
}

export interface CodeLensConnection {
  id: string;
  name: string;
}

export type CodeLensIndexState = "available" | "stale" | "missing";

export interface CodeLensConnections {
  forDocument(documentUri: string): CodeLensConnection | undefined;
  indexState(connection: CodeLensConnection): CodeLensIndexState;
  debugCallAvailability(connection: CodeLensConnection, call: ParsedCallSite): SqlDebugAvailability;
  debugDefinitionAvailability(
    connection: CodeLensConnection,
    definition: FunctionDefinition,
  ): SqlDebugAvailability;
  canDeployManagedRoutine(documentUri: string): boolean;
}

const UNAVAILABLE_INDEX: SqlDebugAvailability = { status: "unavailable", reason: "Index missing" };

const NO_CONNECTIONS: CodeLensConnections = {
  forDocument: () => undefined,
  indexState: () => "missing",
  debugCallAvailability: () => UNAVAILABLE_INDEX,
  debugDefinitionAvailability: () => UNAVAILABLE_INDEX,
  canDeployManagedRoutine: () => false,
};

/** Statement-level causes worth a lens; index state is reported once on the connection lens. */
const STATEMENT_UNAVAILABLE_REASONS = new Set<SqlDebugUnavailableReason>([
  "Several overloads match",
  "Not a PL/pgSQL routine",
  "Call depends on a row value or parameter",
]);

function unavailableLens(range: vscode.Range, reason: SqlDebugUnavailableReason): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title: `$(debug-alt) Debug unavailable: ${reason}`,
    command: "",
    tooltip: "PostgreSQL Workbench does not guess a debugger target from incomplete evidence.",
  });
}

interface SqlCodeLensAnalysis {
  calls: ParsedCallSite[];
  definitions: FunctionDefinition[];
}

const EMPTY_ANALYSIS: SqlCodeLensAnalysis = { definitions: [], calls: [] };

/**
 * Analyzes a whole document; when it has a syntax error, falls back to analyzing each
 * Statement slice so one broken Statement does not hide the entry points of the others.
 */
export async function analyzeSqlDocument(
  sql: string,
  parser: SyntaxParser,
): Promise<SqlCodeLensAnalysis> {
  try {
    return await parseSqlFileStrict(sql, parser);
  } catch (error) {
    if (!(error instanceof UnusableSyntaxTreeError)) throw error;
  }
  const analysis: SqlCodeLensAnalysis = { definitions: [], calls: [] };
  for (const statement of sqlStatementSlices(sql)) {
    try {
      const partial = await parseSqlFileStrict(statement.text, parser);
      const offset = statement.line - 1;
      analysis.definitions.push(
        ...partial.definitions.map((definition) => ({
          ...definition,
          line: definition.line + offset,
        })),
      );
      analysis.calls.push(...partial.calls.map((call) => ({ ...call, line: call.line + offset })));
    } catch (error) {
      if (!(error instanceof UnusableSyntaxTreeError)) throw error;
    }
  }
  return analysis;
}

export const CHOOSE_DOCUMENT_ASSOCIATION_TITLE = "$(database) Choose Document Association";

function connectionLens(
  range: vscode.Range,
  connection: CodeLensConnection | undefined,
  argument: DocumentConnectionTarget,
): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title: connection ? `$(database) ${connection.name}` : CHOOSE_DOCUMENT_ASSOCIATION_TITLE,
    command: "postgresql-workbench.assignDocumentConnection",
    arguments: [argument],
    tooltip: connection
      ? `Document Association: ${connection.name}. Run and Debug use it. Click to change.`
      : "Choose the saved Connexion that Run and Debug use for this document.",
  });
}

function indexStateLens(
  range: vscode.Range,
  connection: CodeLensConnection,
  state: CodeLensIndexState,
): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title:
      state === "stale" ? "$(refresh) Index stale: reindex" : "$(refresh) Index missing: index",
    command: "postgresql-workbench.indexAssociation",
    arguments: [{ serverId: connection.id }],
    tooltip: `Debug needs a fresh Workbench Index of ${connection.name}. Run SQL does not.`,
  });
}

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly analysis = new Map<string, { version: number; value: SqlCodeLensAnalysis }>();
  private readonly analysisPending = new Map<string, { version: number; sql: string }>();
  private readonly analysisRunning = new Set<string>();

  constructor(
    private readonly syntaxParser: () => Promise<SyntaxParser>,
    private readonly connections: CodeLensConnections = NO_CONNECTIONS,
  ) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!shouldProvideSqlCodeLenses(document.uri.scheme)) return [];
    const sql = document.getText();
    const lenses: vscode.CodeLens[] = [];
    const isVirtualPlpgsql =
      document.uri instanceof vscode.Uri && document.uri.scheme === CODE_MONIKER_URI_SCHEME;
    const documentUri = document.uri.toString();
    const documentConnection = this.connections.forDocument(documentUri);
    const cached = this.analysis.get(documentUri);
    const { definitions, calls } =
      cached?.version === document.version ? cached.value : EMPTY_ANALYSIS;
    this.requestAnalysis(documentUri, document.version, sql);

    if (!isVirtualPlpgsql) {
      const statements = sqlStatementSlices(sql);
      for (const statement of statements) {
        const range = new vscode.Range(statement.line - 1, 0, statement.line - 1, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(play) Run SQL",
            command: "postgresql-workbench.runSqlCall",
            arguments: [
              {
                sql: statement.text,
                line: statement.line,
                documentUri,
              } satisfies CommandSqlStatement,
            ],
            tooltip: "Run this PostgreSQL Statement using the Document Association.",
          }),
        );
      }
      const firstStatement = statements[0];
      const range = firstStatement
        ? new vscode.Range(firstStatement.line - 1, 0, firstStatement.line - 1, 0)
        : new vscode.Range(0, 0, 0, 0);
      lenses.push(connectionLens(range, documentConnection, { documentUri }));
      if (documentConnection) {
        const state = this.connections.indexState(documentConnection);
        if (state !== "available") lenses.push(indexStateLens(range, documentConnection, state));
      }
    }

    if (isVirtualPlpgsql && this.connections.canDeployManagedRoutine(documentUri)) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: "$(cloud-upload) Deploy",
          command: "postgresql-workbench.deployManagedRoutine",
          arguments: [document.uri],
          tooltip:
            "Replace the deployed routine with this working copy after validating its identity.",
        }),
      );
    }

    for (const def of definitions) {
      const range = new vscode.Range(def.line - 1, 0, def.line - 1, 0);
      const target = {
        ...def,
        ...(isVirtualPlpgsql ? { symbolUri: document.uri.toString(true) } : {}),
        documentUri: document.uri.toString(),
        documentVersion: document.version,
        ...(isVirtualPlpgsql && documentConnection ? { serverId: documentConnection.id } : {}),
      } satisfies CommandFunctionDefinition;
      const definitionDebug = documentConnection
        ? this.connections.debugDefinitionAvailability(documentConnection, def)
        : undefined;
      if (definitionDebug?.status === "available") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(debug-start) Debug deployed routine",
            command: "postgresql-workbench.debugDefinition",
            arguments: [target],
            tooltip: isVirtualPlpgsql
              ? "Debug the routine deployed in PostgreSQL. An unsaved or undeployed working copy is not debugged."
              : "Debug the routine deployed in PostgreSQL with this signature, not the text of this file. Compare with Database first if unsure.",
          }),
        );
      } else if (
        definitionDebug?.status === "unavailable" &&
        STATEMENT_UNAVAILABLE_REASONS.has(definitionDebug.reason)
      ) {
        lenses.push(unavailableLens(range, definitionDebug.reason));
      }
      if (!isVirtualPlpgsql) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(compare-changes) Compare with Database",
            command: "postgresql-workbench.compareRoutineWithDatabase",
            arguments: [target],
          }),
        );
      }
    }

    for (const call of calls) {
      if (isVirtualPlpgsql || !documentConnection) continue;
      const range = new vscode.Range(call.line - 1, 0, call.line - 1, 0);
      const target = {
        ...call,
        documentUri: document.uri.toString(),
      } satisfies CommandCallSite;
      const callDebug = this.connections.debugCallAvailability(documentConnection, call);
      if (callDebug.status === "available") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(debug-start) Debug PL/pgSQL",
            command: "postgresql-workbench.debugCall",
            arguments: [target],
            tooltip: "Run this Statement with the PL/pgSQL debugger attached to its routine.",
          }),
        );
      } else if (STATEMENT_UNAVAILABLE_REASONS.has(callDebug.reason)) {
        lenses.push(unavailableLens(range, callDebug.reason));
      }
    }

    return lenses;
  }

  private requestAnalysis(documentUri: string, version: number, sql: string): void {
    if (this.analysis.get(documentUri)?.version === version) return;
    const pending = this.analysisPending.get(documentUri);
    if (pending?.version === version) return;
    this.analysisPending.set(documentUri, { version, sql });
    if (this.analysisRunning.has(documentUri)) return;
    this.analysisRunning.add(documentUri);
    void this.drainAnalysis(documentUri).finally(() => this.analysisRunning.delete(documentUri));
  }

  private async drainAnalysis(documentUri: string): Promise<void> {
    while (true) {
      const requested = this.analysisPending.get(documentUri);
      if (!requested) return;
      this.analysisPending.delete(documentUri);
      try {
        const parser = await this.syntaxParser();
        const value = await analyzeSqlDocument(requested.sql, parser);
        if (this.analysisPending.has(documentUri)) continue;
        this.analysis.set(documentUri, { version: requested.version, value });
        this._onDidChangeCodeLenses.fire();
      } catch {
        if (this.analysis.get(documentUri)?.version === requested.version) {
          this.analysis.delete(documentUri);
        }
      }
    }
  }
}
