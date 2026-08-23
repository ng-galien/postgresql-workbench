import * as vscode from "vscode";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import {
  analyzePlpgsqlDocument,
  findIdentifierColumns,
} from "../../../packages/sql/src/routines/documentAnalysis.js";

const MAX_VALUE_LEN = 60;

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > MAX_VALUE_LEN ? `${flat.slice(0, MAX_VALUE_LEN - 1)}…` : flat;
}

/**
 * Fetch a frame's variables (all scopes) from the active plpgsql debug
 * session. Uses the frame id VS Code hands the provider when available,
 * falling back to the top frame. Returns null when there is no session or a
 * request fails — the provider then falls back to VS Code's variable lookup.
 */
async function activeSessionVariables(
  frameId: number | undefined,
): Promise<Map<string, string> | null> {
  const session = vscode.debug.activeDebugSession;
  if (session?.type !== "postgresql-workbench") return null;
  try {
    if (frameId === undefined) {
      const threads = await session.customRequest("threads");
      const threadId = threads?.threads?.[0]?.id;
      if (threadId === undefined) return null;
      const stack = await session.customRequest("stackTrace", { threadId });
      frameId = stack?.stackFrames?.[0]?.id;
      if (frameId === undefined) return null;
    }
    const scopes = await session.customRequest("scopes", { frameId });

    const varsPerScope = await Promise.all(
      (scopes?.scopes ?? []).map((scope: { variablesReference: number }) =>
        session.customRequest("variables", { variablesReference: scope.variablesReference }),
      ),
    );
    const values = new Map<string, string>();
    for (const vars of varsPerScope) {
      for (const variable of vars?.variables ?? []) {
        if (!values.has(variable.name)) values.set(variable.name, variable.value);
      }
    }
    return values;
  } catch {
    return null;
  }
}

/**
 * Provides inline variable values during PL/pgSQL debugging.
 *
 * Parses the visible PL/pgSQL routines and anchors inline values only on
 * variables known to the routine being displayed. Values are resolved
 * directly from the active debug session (deterministic InlineValueText);
 * when that fails, VS Code's own variable lookup is used as fallback.
 */
export class PlpgsqlInlineValuesProvider implements vscode.InlineValuesProvider {
  constructor(private readonly syntaxParser: () => Promise<SyntaxParser>) {}

  async provideInlineValues(
    document: vscode.TextDocument,
    viewPort: vscode.Range,
    context: vscode.InlineValueContext,
  ): Promise<vscode.InlineValue[]> {
    const values: vscode.InlineValue[] = [];
    const routines = await analyzePlpgsqlDocument(document, await this.syntaxParser());
    if (routines.length === 0) return values;

    const visibleRoutines = routines.filter(
      (routine) =>
        routine.bodyStartLine <= viewPort.end.line && routine.bodyEndLine >= viewPort.start.line,
    );
    if (visibleRoutines.length === 0) return values;

    const sessionValues = await activeSessionVariables(context.frameId);
    const seen = new Set<string>();

    const pushAnchors = (lineNum: number, names: string[]) => {
      const lineText = document.lineAt(lineNum).text;
      const trimmed = lineText.trim();
      if (trimmed.startsWith("--") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;

      for (const name of names) {
        for (const col of findIdentifierColumns(lineText, name)) {
          const key = `${lineNum}:${col}:${name}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const range = new vscode.Range(lineNum, col, lineNum, col + name.length);
          const value = sessionValues?.get(name);
          values.push(
            value !== undefined
              ? new vscode.InlineValueText(range, `${name} = ${truncate(value)}`)
              : new vscode.InlineValueVariableLookup(range, name),
          );
        }
      }
    };

    for (const routine of visibleRoutines) {
      const variableNames = [...new Set(routine.variables.map((variable) => variable.name))];
      const paramNames = [
        ...new Set(
          routine.variables.filter((variable) => variable.isParam).map((variable) => variable.name),
        ),
      ];

      const headStart = Math.max(viewPort.start.line, routine.statementStartLine);
      const headEnd = Math.min(viewPort.end.line, routine.bodyStartLine - 1);
      for (let lineNum = headStart; lineNum <= headEnd; lineNum++) {
        pushAnchors(lineNum, paramNames);
      }

      const startLine = Math.max(viewPort.start.line, routine.bodyStartLine);
      const endLine = Math.min(viewPort.end.line, routine.bodyEndLine);
      for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        pushAnchors(lineNum, variableNames);
      }
    }

    return values;
  }
}
