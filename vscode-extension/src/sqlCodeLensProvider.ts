import * as vscode from "vscode";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import type { FunctionDefinition, ParsedCallSite } from "../../src/callParser.js";
import { parseSqlFileStrict } from "../../src/callParser.js";
import { CODE_MONIKER_URI_SCHEME } from "./codeMonikerUri.js";
import { sqlStatementSlices } from "./sqlAuthoring/sqlLexing.js";
import { shouldProvideSqlCodeLenses } from "./sqlCodeLensPolicy.js";

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

export interface CodeLensConnections {
  forDocument(documentUri: string): CodeLensConnection | undefined;
  canDebugCall(connection: CodeLensConnection, call: ParsedCallSite): boolean;
  canDebugDefinition(connection: CodeLensConnection, definition: FunctionDefinition): boolean;
  canDeployManagedRoutine(documentUri: string): boolean;
}

const NO_CONNECTIONS: CodeLensConnections = {
  forDocument: () => undefined,
  canDebugCall: () => false,
  canDebugDefinition: () => false,
  canDeployManagedRoutine: () => false,
};

interface SqlCodeLensAnalysis {
  calls: ParsedCallSite[];
  definitions: FunctionDefinition[];
}

const EMPTY_ANALYSIS: SqlCodeLensAnalysis = { definitions: [], calls: [] };

function connectionLens(
  range: vscode.Range,
  connection: CodeLensConnection | undefined,
  command: string,
  argument?: DocumentConnectionTarget,
): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title: connection
      ? `$(database) ${connection.name}`
      : "$(database) Choose PostgreSQL connection",
    command,
    ...(argument ? { arguments: [argument] } : {}),
    tooltip: connection
      ? `PostgreSQL connection: ${connection.name}. Click to change.`
      : "Choose the PostgreSQL Document Association.",
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
      lenses.push(
        connectionLens(range, documentConnection, "postgresql-workbench.assignDocumentConnection", {
          documentUri,
        }),
      );
    }

    if (isVirtualPlpgsql && this.connections.canDeployManagedRoutine(documentUri)) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: "$(cloud-upload) Deploy managed routine",
          command: "postgresql-workbench.deployManagedRoutine",
          arguments: [document.uri],
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
      if (documentConnection && this.connections.canDebugDefinition(documentConnection, def)) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(debug-start) Debug PL/pgSQL ${def.kind}`,
            command: "postgresql-workbench.debugDefinition",
            arguments: [target],
          }),
        );
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
      if (isVirtualPlpgsql || !call.isLaunchable) {
        continue;
      }
      const range = new vscode.Range(call.line - 1, 0, call.line - 1, 0);
      const target = {
        ...call,
        documentUri: document.uri.toString(),
      } satisfies CommandCallSite;
      const connection = this.connections.forDocument(documentUri);
      if (connection && this.connections.canDebugCall(connection, call)) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(debug-start) Debug PL/pgSQL",
            command: "postgresql-workbench.debugCall",
            arguments: [target],
          }),
        );
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
        const value = await parseSqlFileStrict(requested.sql, parser);
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
