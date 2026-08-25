import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DataViewValueEditor } from "../../../rows/src/dataView/dataView.js";

export interface CellEditorProps {
  editor: DataViewValueEditor;
  value: string | null;
  /** Whether the reader has given this column anything, NULL included. A loaded row always has. */
  given: boolean;
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

  const onDraft = (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    typed.current = true;
    setDraft(event.target.value);
  };

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
  /*
   * Enter and a lost focus commit whatever the field holds, whether or not the reader put it there.
   * If they never typed, that is not a value they chose: looking at an empty cell used to set it to
   * an empty text, and a column left to the database — a DEFAULT, a sequence — was then given `''`
   * to insert, which its type refuses. Typing is what is asked about and not the value the draft
   * ended on, so a reader who types and then clears still means the empty text.
   *
   * Every other way of committing carries a value the reader picked — an option, NULL, the default —
   * and goes straight to `commit`, which is why this question is asked here and not in there.
   */
  const commitDraft = () => (typed.current ? commit(draft) : onCancel());

  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    // Typing belongs to the editor: the grid behind it navigates and acts on the same keys.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !(editor === "json" && event.shiftKey)) {
      event.preventDefault();
      commitDraft();
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

  /* Which of the two the cell is holding right now, named once rather than spelled on each button. */
  const leftToDatabase = onLeaveToDatabase !== undefined && !given;

  return (
    <div className={`cell-editor${error ? " invalid" : ""}`} title={error}>
      {editor === "json" ? (
        <textarea
          ref={input}
          className="cell-editor-input"
          value={draft}
          rows={1}
          placeholder={PLACEHOLDERS[editor]}
          onChange={onDraft}
          onKeyDown={handleKey}
          onBlur={commitDraft}
          aria-label="Cell value"
          aria-invalid={error ? true : undefined}
        />
      ) : (
        <input
          ref={input}
          className="cell-editor-input"
          value={draft}
          placeholder={PLACEHOLDERS[editor]}
          onChange={onDraft}
          onKeyDown={handleKey}
          onBlur={commitDraft}
          aria-label="Cell value"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
        />
      )}
      <div className="cell-editor-empties">
        <button
          type="button"
          className="cell-editor-empty"
          title="Insert NULL"
          aria-pressed={value === null && !leftToDatabase}
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
            aria-pressed={leftToDatabase}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onLeaveToDatabase}
          >
            DEFAULT
          </button>
        ) : null}
      </div>
    </div>
  );
}
