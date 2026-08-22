import type { MouseEvent as ReactMouseEvent } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type { DataViewRowInsertion } from "../../../rows/src/dataView/dataView.js";
import { CellEditor } from "./CellEditor.js";
import { isWebAddress } from "./cellDetail.js";
import type { HeaderColumn } from "./GridHeader.js";
import {
  cellIsSelected,
  cellSelection,
  extendedTo,
  type GridSelection,
  isAnchor,
  rowIsSelected,
  rowSelection,
  selectedRows,
} from "./gridSelection.js";
import type { GridEditing } from "./ResultGrid.js";

/**
 * A row of the grid: one the result answered with, or one the reader is adding.
 *
 * The two used to be drawn by two nearly identical pieces of code, and they had drifted — a row
 * being added showed no link, said nothing about a value cut short, and named itself differently
 * in its own tooltip. They are one thing with two answers to three questions: what the gutter
 * shows, where a value comes from, and what committing an edit means.
 */
export type GridRowSubject =
  | {
      of: "loaded";
      /** The cells as the result gave them. */
      cells: readonly DebugResultCell[];
      /** Where the row sits among the loaded rows, which is what an edit is addressed to. */
      loadedIndex: number;
      /** What the gutter says: counted from the start of the page, not of the result. */
      number: number;
      removed: boolean;
    }
  | { of: "added"; added: DataViewRowInsertion };

/** Everything a row needs to draw itself and to answer a gesture, held by the grid. */
export interface GridRowContext {
  columns: readonly HeaderColumn[];
  visibleOrdinals: readonly number[];
  selection: GridSelection;
  setSelection(next: GridSelection): void;
  /** Leaves the keystrokes with the grid when a press lands on a cell. */
  takeKeys(event: ReactMouseEvent<HTMLElement>): void;
  cellId(row: number, ordinal: number): string;
  /** Cells holding what the reader is looking for, keyed `shownRow:ordinal`. */
  matched: ReadonlySet<string>;
  editing?: GridEditing;
  /** Which cell is open for editing right now, whichever kind of row it is on. */
  isEditingCell(subject: GridRowSubject, ordinal: number): boolean;
  openEditor(subject: GridRowSubject, ordinal: number, cell: DebugResultCell): void;
  closeEditor(): void;
}

export function GridRow({
  subject,
  shownRow,
  context,
}: {
  subject: GridRowSubject;
  /** Where the row sits among everything on screen, which is what the selection counts in. */
  shownRow: number;
  context: GridRowContext;
}) {
  const { columns, visibleOrdinals, selection, setSelection, takeKeys, cellId, editing } = context;
  const added = subject.of === "added" ? subject.added : undefined;
  const selectedRow = rowIsSelected(selection, shownRow);
  const band = selectedRows(selection);
  return (
    <tr
      aria-rowindex={subject.of === "loaded" ? subject.number + 1 : undefined}
      className={[
        added ? "added" : "",
        subject.of === "loaded" && subject.removed ? "removed" : "",
        selectedRow ? "row-selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <th
        scope="row"
        className={[
          "row-gutter",
          selectedRow ? "selected" : "",
          shownRow >= band.first && shownRow <= band.last ? "in-selection" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-selected={selectedRow}
        title={`${
          subject.of === "added" ? "New row" : `Row ${subject.number}`
        } — click to select it, shift-click to extend`}
        onMouseDown={(event) => {
          takeKeys(event);
          const at = { row: shownRow, ordinal: visibleOrdinals[0] ?? 0 };
          setSelection(
            event.shiftKey ? extendedTo(selection, at, "rows") : rowSelection(at.row, at.ordinal),
          );
        }}
      >
        {subject.of === "added" ? (
          <span className="row-gutter-state added" role="img" aria-label="New row">
            ✚
          </span>
        ) : subject.removed ? (
          <span className="row-gutter-state removed" role="img" aria-label="Row deleted">
            ✕
          </span>
        ) : (
          <span className="row-gutter-number">{subject.number}</span>
        )}
      </th>
      {columns.map(({ key, ordinal, value: column }) => {
        const policy = editing?.policies[ordinal];
        const cell = cellOf(subject, ordinal, column.name, editing);
        const shown = cell.value;
        const editingHere = context.isEditingCell(subject, ordinal);
        return (
          <td
            key={key}
            id={cellId(shownRow, ordinal)}
            {...(subject.of === "added"
              ? { "data-added-row": subject.added.localId }
              : { "data-row": subject.loadedIndex })}
            data-column={ordinal}
            className={[
              shown === null ? "null" : cell.kind === "null" ? "text" : cell.kind,
              cell.truncated ? "truncated" : "",
              cell.edited ? "edited" : "",
              cellIsSelected(selection, shownRow, ordinal, visibleOrdinals) ? "selected" : "",
              isAnchor(selection, shownRow, ordinal) ? "anchor" : "",
              context.matched.has(`${shownRow}:${ordinal}`) ? "match" : "",
              policy && !policy.editable ? "read-only" : "",
              editingHere ? "editing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={
              cell.edited
                ? `Original: ${cell.raw ?? "NULL"}`
                : policy && !policy.editable
                  ? policy.reason
                  : undefined
            }
            onMouseDown={(event) => {
              // A click puts the anchor here; a shifted one reaches from where it was.
              takeKeys(event);
              setSelection(
                event.shiftKey
                  ? extendedTo(selection, { row: shownRow, ordinal }, "cells")
                  : cellSelection(shownRow, ordinal),
              );
            }}
            onDoubleClick={() => context.openEditor(subject, ordinal, cell)}
          >
            {editingHere && policy?.editable && editing ? (
              <CellEditor
                editor={policy.editor}
                value={shown}
                onCommit={(next) => {
                  context.closeEditor();
                  if (added) editing.rows?.fill(added.localId, { [column.name]: next });
                  else if (subject.of === "loaded") {
                    editing.onEdit(subject.cells, subject.loadedIndex, ordinal, next, cell.raw);
                  }
                }}
                onCancel={() => context.closeEditor()}
              />
            ) : shown !== null && isWebAddress(shown) ? (
              /* An address is somewhere to go, so it reads and behaves as one. */
              <a
                className="cell-value cell-link"
                href={shown}
                target="_blank"
                rel="noreferrer"
                title={`Open ${shown}`}
              >
                {shown}
              </a>
            ) : (
              <span className="cell-value">{shown === null ? emptyLabel(subject) : shown}</span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

/** What a cell of this row holds: what is drawn, and what the result gave before any edit. */
interface ShownCell extends DebugResultCell {
  edited?: boolean;
  /**
   * What the result answered with, whether or not it has since been edited. An edit is always
   * reported against this — never against a previous edit — or the first change a reader makes
   * would become what the database is told the row used to hold.
   */
  raw: string | null;
}

function cellOf(
  subject: GridRowSubject,
  ordinal: number,
  columnName: string,
  editing?: GridEditing,
): ShownCell {
  if (subject.of === "added") {
    const filled = subject.added.values[columnName] ?? null;
    return { kind: filled === null ? "null" : "text", value: filled, raw: filled };
  }
  const cell = subject.cells[ordinal] ?? { kind: "null" as const, value: null };
  const edit = editing?.editFor(subject.cells, subject.loadedIndex, ordinal);
  return edit
    ? { ...cell, value: edit.value, edited: true, raw: cell.value }
    : { ...cell, raw: cell.value };
}

/*
 * A row being added has a third answer for a column with nothing in it: not a value, not an empty
 * text, but "whatever the database would have given it". That is not the same as a loaded NULL.
 */
function emptyLabel(subject: GridRowSubject): string {
  return subject.of === "added" ? "DEFAULT" : "NULL";
}
