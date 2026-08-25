import type { MouseEvent as ReactMouseEvent } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type { DataViewRowInsertion } from "../../../rows/src/dataView/dataView.js";
import { chordName } from "../platform.js";
import { CellEditor } from "./CellEditor.js";
import { CELL_LINK, followsCellLink, isWebAddress } from "./cellDetail.js";
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
  /** The menu a reader asks for on a cell, wherever they asked for it. */
  onCellMenu(
    event: ReactMouseEvent<HTMLElement>,
    shownRow: number,
    ordinal: number,
    value: string | null,
  ): void;
  cellId(row: number, ordinal: number): string;
  /** Cells holding what the reader is looking for, keyed `shownRow:ordinal`. */
  matched: ReadonlySet<string>;
  editing?: GridEditing;
  /** Which cell is open for editing right now, whichever kind of row it is on. */
  isEditingCell(subject: GridRowSubject, ordinal: number): boolean;
  openEditor(shownRow: number, ordinal: number): void;
  closeEditor(): void;
  /** What the reader asked for when they asked for the address a cell holds. */
  onFollowLink(href: string): void;
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
          <span
            className="row-gutter-state added codicon codicon-add"
            role="img"
            aria-label="New row"
          />
        ) : subject.removed ? (
          <span
            className="row-gutter-state removed codicon codicon-trash"
            role="img"
            aria-label="Row deleted"
          />
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
              cell.retainedTruncated
                ? "Value truncated at the configured results.maxCellBytes limit. Change PostgreSQL Workbench › Results: Max Cell Bytes in Settings."
                : cell.truncated
                  ? "Value shortened in the grid. Inspect it to read the full retained value."
                  : cell.edited
                    ? `Original: ${cell.raw ?? "NULL"}`
                    : policy && !policy.editable
                      ? policy.reason
                      : undefined
            }
            onContextMenu={(event) => context.onCellMenu(event, shownRow, ordinal, shown)}
            onClick={(event) => {
              const target = event.target instanceof HTMLElement ? event.target : undefined;
              if (
                shown !== null &&
                isWebAddress(shown) &&
                target?.closest(`.${CELL_LINK}`) &&
                followsCellLink(event)
              ) {
                context.onFollowLink(shown);
              }
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                shown !== null &&
                isWebAddress(shown) &&
                followsCellLink(event)
              ) {
                event.preventDefault();
                context.onFollowLink(shown);
              }
            }}
            onMouseDown={(event) => {
              // A click puts the anchor here; a shifted one reaches from where it was.
              takeKeys(event);
              setSelection(
                event.shiftKey
                  ? extendedTo(selection, { row: shownRow, ordinal }, "cells")
                  : cellSelection(shownRow, ordinal),
              );
            }}
            onDoubleClick={() => context.openEditor(shownRow, ordinal)}
          >
            {editingHere && policy?.editable && editing ? (
              <CellEditor
                editor={policy.editor}
                value={shown}
                given={cell.given}
                {...(policy.hasDefault
                  ? {
                      onLeaveToDatabase: () => {
                        context.closeEditor();
                        if (added) {
                          editing.rows?.fill(added.localId, {}, [column.name]);
                        } else if (subject.of === "loaded") {
                          editing.onEdit(
                            subject.cells,
                            subject.loadedIndex,
                            ordinal,
                            null,
                            cell.raw,
                            true,
                          );
                        }
                      },
                    }
                  : {})}
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
              <span
                className={`cell-value ${CELL_LINK}`}
                /*
                 * The value stays text because its only pointer action is the editor chord. A real
                 * anchor would promise Enter and an ordinary click, both of which belong to the
                 * grid. Keyboard readers reach the explicit Open action in the cell menu.
                 */
                title={`${chordName()}+click to open ${shown}`}
              >
                {shown}
              </span>
            ) : (
              <span className="cell-value">
                {shown === null ? emptyLabel(subject, cell.given === true) : shown}
              </span>
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
  /** On a row being added: whether the reader has given this column anything, NULL included. */
  given?: boolean;
}

function cellOf(
  subject: GridRowSubject,
  ordinal: number,
  columnName: string,
  editing?: GridEditing,
): ShownCell {
  if (subject.of === "added") {
    const given = columnName in subject.added.values;
    const filled = given ? (subject.added.values[columnName] ?? null) : null;
    return { kind: filled === null ? "null" : "text", value: filled, raw: filled, given };
  }
  const cell = {
    ...(subject.cells[ordinal] ?? { kind: "null" as const, value: null }),
    given: true,
  };
  const edit = editing?.editFor(subject.cells, subject.loadedIndex, ordinal);
  if (!edit) return { ...cell, raw: cell.value };
  // A column asked for its default holds no value to show until PostgreSQL has written one.
  if (edit.toDefault) {
    return { ...cell, kind: "null", value: null, edited: true, raw: cell.value, given: false };
  }
  return { ...cell, value: edit.value, edited: true, raw: cell.value, given: true };
}

/*
 * A cell holding no text says which of three things that means. On a loaded row there is only one:
 * NULL. On a row being added there are two, and they are not the same row in the database — an
 * explicit NULL is inserted, a column left alone is not named at all and takes the table's default.
 */
function emptyLabel(_subject: GridRowSubject, given: boolean): string {
  return given ? "NULL" : "DEFAULT";
}
