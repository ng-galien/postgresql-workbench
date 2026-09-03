import * as vscode from "vscode";
import {
  normalizeMetadata,
  parseSqlNotebookFile,
  type SqlNotebookFile,
  scratchpadCellExecutionIntent,
  serializeSqlNotebookFile,
} from "../../../packages/scratchpad/src/notebookFile.js";

/**
 * Reading a Scratchpad off disk and writing it back. The file format itself is notebookFile's;
 * this only carries it across VS Code's own notebook API.
 */

export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const file = parseSqlNotebookFile(new TextDecoder().decode(content));
    const data = new vscode.NotebookData(
      file.cells.map((cell) => {
        const data = new vscode.NotebookCellData(
          cell.kind === "markup" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
          cell.source,
          cell.language,
        );
        data.metadata = cell.metadata;
        return data;
      }),
    );
    data.metadata = file.metadata;
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const file: SqlNotebookFile = {
      version: 1,
      metadata: normalizeMetadata(data.metadata),
      cells: data.cells.map((cell) =>
        cell.kind === vscode.NotebookCellKind.Markup
          ? { kind: "markup", language: "markdown", source: cell.value }
          : {
              kind: "code",
              language: "plpgsql",
              source: cell.value,
              ...(scratchpadCellExecutionIntent(cell.metadata) === "debug"
                ? { metadata: { executionIntent: "debug" as const } }
                : {}),
            },
      ),
    };
    return new TextEncoder().encode(serializeSqlNotebookFile(file));
  }
}
