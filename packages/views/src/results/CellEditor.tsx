import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type {
  DataViewColumnPolicy,
  DataViewEdit,
  DataViewValueEditor,
} from "../../../rows/src/dataView.js";

/** Editing contract handed to the grid by a host that owns the pending edits. */
export interface GridEditing {
  policies: readonly DataViewColumnPolicy[];
  /** The pending edit shown in a cell, if any. */
  editFor(
    row: readonly DebugResultCell[],
    rowIndex: number,
    ordinal: number,
  ): DataViewEdit | undefined;
  onEdit(
    row: readonly DebugResultCell[],
    rowIndex: number,
    ordinal: number,
    value: string | null,
    original: string | null,
  ): void;
  /**
   * Whole rows, when there is exactly one table to write them to. A grid over a join can still
   * have its cells edited; which table a row would be taken from is not for the grid to guess.
   */
  rows?: {
    /** Whether this row is one the reader took away, and is shown struck through. */
    isRemoved(row: readonly DebugResultCell[], rowIndex: number): boolean;
    /** Takes this row away, or puts it back. */
    toggleRemoval(row: readonly DebugResultCell[], rowIndex: number): void;
    /** Rows the reader added; they live below the loaded ones until the changes are applied. */
    added: readonly { localId: string; values: Record<string, string | null> }[];
    add(): void;
    drop(localId: string): void;
    /** Fills one column of an added row; null leaves the column to PostgreSQL. */
    fill(localId: string, column: string, value: string | null): void;
  };
}

export interface CellEditorProps {
  editor: DataViewValueEditor;
  value: string | null;
  onCommit(value: string | null): void;
  onCancel(): void;
}

const PLACEHOLDERS: Record<DataViewValueEditor, string> = {
  text: "",
  number: "0",
  boolean: "",
  json: '{"key": "value"}',
  date: "YYYY-MM-DD",
  time: "HH:MM:SS",
  timestamp: "YYYY-MM-DD HH:MM:SS",
};

/** Validates a value before it becomes a local edit; PostgreSQL remains the final judge. */
export function validateCellValue(editor: DataViewValueEditor, value: string): string | undefined {
  if (editor === "json") {
    try {
      JSON.parse(value);
    } catch {
      return "Enter valid JSON.";
    }
  }
  if (
    editor === "number" &&
    !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$|^\s*(NaN|[-+]?Infinity)\s*$/u.test(value)
  ) {
    return "Enter a number.";
  }
  if (
    editor === "date" &&
    !/^\s*\d{4}-\d{2}-\d{2}\s*$|^\s*(today|yesterday|tomorrow|now|infinity|-infinity|epoch)\s*$/iu.test(
      value,
    )
  ) {
    return "Enter a date as YYYY-MM-DD.";
  }
  return undefined;
}

export function CellEditor({ editor, value, onCommit, onCancel }: CellEditorProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select?.();
  }, []);

  const commit = (next: string | null) => {
    if (next !== null) {
      const problem = validateCellValue(editor, next);
      if (problem) {
        setError(problem);
        return;
      }
    }
    onCommit(next);
  };
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    // Typing belongs to the editor: the grid behind it navigates and acts on the same keys.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !(editor === "json" && event.shiftKey)) {
      event.preventDefault();
      commit(draft);
    }
  };

  if (editor === "boolean") {
    return (
      <div className="cell-editor">
        <select
          ref={input}
          className="cell-editor-input"
          value={value === null ? "NULL" : value === "true" || value === "t" ? "true" : "false"}
          onChange={(event) => commit(event.target.value === "NULL" ? null : event.target.value)}
          onKeyDown={handleKey}
          onBlur={onCancel}
          aria-label="Boolean value"
        >
          <option value="true">true</option>
          <option value="false">false</option>
          <option value="NULL">NULL</option>
        </select>
      </div>
    );
  }

  return (
    <div className={`cell-editor${error ? " invalid" : ""}`} title={error}>
      {editor === "json" ? (
        <textarea
          ref={input}
          className="cell-editor-input"
          value={draft}
          rows={1}
          placeholder={PLACEHOLDERS[editor]}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          onBlur={() => commit(draft)}
          aria-label="Cell value"
          aria-invalid={error ? true : undefined}
        />
      ) : (
        <input
          ref={input}
          className="cell-editor-input"
          value={draft}
          placeholder={PLACEHOLDERS[editor]}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          onBlur={() => commit(draft)}
          aria-label="Cell value"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
        />
      )}
      <button
        type="button"
        className="cell-editor-null"
        title="Set NULL"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommit(null)}
      >
        ∅
      </button>
    </div>
  );
}
