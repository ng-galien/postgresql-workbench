import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DataViewValueEditor } from "../../../rows/src/dataView/dataView.js";

export interface CellEditorProps {
  editor: DataViewValueEditor;
  value: string | null;
  /** On a row being added: whether the reader has given this column anything, NULL included. */
  given?: boolean;
  onCommit(value: string | null): void;
  /**
   * Leaves the column out of the INSERT, so the table gives it whatever it would have given. Only
   * a row being added has this state; a loaded row already holds something, if only NULL.
   */
  onLeaveToDatabase?: () => void;
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

export function CellEditor({
  editor,
  value,
  given,
  onCommit,
  onLeaveToDatabase,
  onCancel,
}: CellEditorProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string>();
  const typed = useRef(false);
  const input = useRef<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select?.();
  }, []);

  /*
   * An editor the reader never typed into has nothing to say. Committing anyway turned looking at
   * an empty cell into setting it to an empty text, and a column left to the database — a DEFAULT,
   * a sequence — was then given `''` to insert, which its type refuses. Typing is what is asked
   * about, not the value it ended on: a reader who types and then clears means the empty text.
   */
  const commit = (next: string | null) => {
    if (next !== null && !typed.current) {
      onCancel();
      return;
    }
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
          onChange={(event) => {
            typed.current = true;
            setDraft(event.target.value);
          }}
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
          onChange={(event) => {
            typed.current = true;
            setDraft(event.target.value);
          }}
          onKeyDown={handleKey}
          onBlur={() => commit(draft)}
          aria-label="Cell value"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
        />
      )}
      <button
        type="button"
        className="cell-editor-empty"
        title="Insert NULL"
        aria-pressed={onLeaveToDatabase ? given === true && value === null : value === null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommit(null)}
      >
        NULL
      </button>
      {onLeaveToDatabase ? (
        <button
          type="button"
          className="cell-editor-empty"
          title="Leave it to the database"
          aria-pressed={given !== true}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onLeaveToDatabase}
        >
          DEFAULT
        </button>
      ) : null}
    </div>
  );
}
