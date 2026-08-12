import * as vscode from "vscode";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import type { FunctionDefinition, ParsedCallSite } from "../../src/callParser.js";
import { parseSqlFile } from "../../src/callParser.js";
import { CODE_MONIKER_URI_SCHEME } from "./codeMonikerUri.js";

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

export interface CodeLensConnection {
  id: string;
  name: string;
}

export interface CodeLensConnections {
  active(): CodeLensConnection | undefined;
  forCall(call: CommandCallSite): CodeLensConnection | undefined;
  canDebug(connection: CodeLensConnection): boolean;
}

const NO_CONNECTIONS: CodeLensConnections = {
  active: () => undefined,
  forCall: () => undefined,
  canDebug: () => false,
};

function connectionLens(
  range: vscode.Range,
  connection: CodeLensConnection | undefined,
  command: string,
  argument?: CommandCallSite,
): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title: connection
      ? `$(database) ${connection.name}`
      : "$(database) Choose PostgreSQL connection",
    command,
    ...(argument ? { arguments: [argument] } : {}),
    tooltip: connection
      ? `PostgreSQL connection: ${connection.name}. Click to change.`
      : "Choose the PostgreSQL connection for this callsite.",
  });
}

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly syntaxParser: () => Promise<SyntaxParser>,
    private readonly connections: CodeLensConnections = NO_CONNECTIONS,
  ) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const sql = document.getText();
    const { definitions, calls } = await parseSqlFile(sql, await this.syntaxParser());
    const lenses: vscode.CodeLens[] = [];
    const isVirtualPlpgsql =
      document.uri instanceof vscode.Uri && document.uri.scheme === CODE_MONIKER_URI_SCHEME;
    const activeConnection = this.connections.active();

    for (const def of definitions) {
      const range = new vscode.Range(def.line - 1, 0, def.line - 1, 0);
      const target = {
        ...def,
        ...(isVirtualPlpgsql ? { symbolUri: document.uri.toString(true) } : {}),
        documentUri: document.uri.toString(),
        documentVersion: document.version,
        ...(activeConnection ? { serverId: activeConnection.id } : {}),
      } satisfies CommandFunctionDefinition;
      if (activeConnection && this.connections.canDebug(activeConnection)) {
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
      lenses.push(connectionLens(range, activeConnection, "postgresql-workbench.pickConnection"));
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
      const connection = this.connections.forCall(target);
      if (!connection) {
        lenses.push(
          connectionLens(range, undefined, "postgresql-workbench.assignCallConnection", target),
        );
        continue;
      }
      if (this.connections.canDebug(connection)) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(debug-start) Debug PL/pgSQL",
            command: "postgresql-workbench.debugCall",
            arguments: [
              {
                ...target,
                serverId: connection.id,
              } satisfies CommandCallSite,
            ],
          }),
        );
      }
      lenses.push(
        connectionLens(range, connection, "postgresql-workbench.assignCallConnection", target),
      );
    }

    return lenses;
  }
}
