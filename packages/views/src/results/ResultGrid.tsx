import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { isWebAddress } from "../../../rows/src/cellDetail.js";
import { clamp } from "../../../rows/src/clamp.js";
import type {
  DataViewColumnPolicy,
  DataViewEdit,
  DataViewRowInsertion,
} from "../../../rows/src/dataView.js";
import {
  CLIPBOARD_EXPORT,
  dataViewExportText,
  parseDelimitedText,
} from "../../../rows/src/export.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { rowOrder } from "../../../rows/src/rowOrder.js";
import { shownValues } from "../../../rows/src/shownValues.js";
import { CellEditor } from "./CellEditor.js";
import { CellInspector } from "./CellInspector.js";
import {
  cellIsSelected,
  cellSelection,
  extendedTo,
  type GridSelection,
  isAnchor,
  movedSelection,
  rowIsSelected,
  rowSelection,
  sameSelection,
  selectedOrdinals,
  selectedRows,
} from "./gridSelection.js";
import {
  columnWidthsCh,
  nextResultSort,
  type ResultSort,
  resultSortNotice,
  sortedResultRows,
} from "./resultFormatting.js";

const RESULT_ROW_HEIGHT = 28;
const RESULT_VIEWPORT_HEIGHT = 360;
const RESULT_OVERSCAN = 8;
const RESULT_SCROLLBAR_MIN_THUMB_HEIGHT = 24;

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
}

interface ScrollbarGeometry {
  thumbHeight: number;
  thumbTop: number;
  maxScrollTop: number;
  maxThumbTop: number;
}

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
    isRemoved(row: readonly DebugResultCell[]): boolean;
    /** Rows the reader added, in the order they are shown, each over the row it was added on. */
    added: readonly DataViewRowInsertion[];
    drop(localId: string): void;
    /** Fills columns of an added row; null leaves a column to PostgreSQL. */
    fill(localId: string, values: Record<string, string | null>): void;
    /** Adds a row already filled in — a line of a paste that fell past the last loaded row. */
    appendPasted(values: Record<string, string | null>, above: number): void;
  };
}

export interface ResultGridProps {
  /** Only the table: a grid never needed the Connexion or the Statement behind it. */
  payload: ResultTable;
  /*
   * What is picked out, held by whoever shows what acts on it — the count in the edit bar, the
   * rows an export writes. Picking rows out is not editing them, so this is the grid's own
   * capability and not the writable surface's; a grid nobody is holding one for holds its own.
   */
  selection?: GridSelection;
  onSelect?: (next: GridSelection) => void;
  /*
   * Whether the value under the cursor is shown beside the grid. A row can only show one line cut
   * off where the column ends; whoever put the grid on screen decides whether a reader also gets
   * the whole of what the cursor is on.
   */
  inspecting?: boolean;
  onInspecting?: (on: boolean) => void;
  /** When set, sorting is delegated to the host (server-side) instead of sorting loaded rows. */
  serverSort?: {
    /** Active server-side sorts in priority order. */
    sorts: ResultSort[];
    /** `additive` (Shift+click) keeps the other sorts and toggles this column. */
    onSort(columnIndex: number, additive: boolean): void;
  };
  /** When set, cells become editable according to the column policies. */
  editing?: GridEditing;
  /** Column layout controls: hidden ordinals, drag reorder, and a per-column menu. */
  layout?: GridLayout;
}

export interface GridLayout {
  hidden: ReadonlySet<number>;
  onReorder(from: number, to: number): void;
  menuItems(ordinal: number): { label: string; action: () => void }[];
  /** Accent color (CSS value) of the table a column comes from; undefined for computed values. */
  columnAccent?(ordinal: number): string | undefined;
}

export function ResultGrid({
  payload,
  serverSort,
  editing,
  layout,
  selection: heldSelection,
  onSelect,
  inspecting,
  onInspecting,
}: ResultGridProps) {
  /** Which cell of which added row is being filled in right now. */
  const [activeAdded, setActiveAdded] = useState<{ localId: string; ordinal: number }>();
  const [localSort, setLocalSort] = useState<ResultSort>();
  const [activeCell, setActiveCell] = useState<{ row: number; ordinal: number }>();
  /** Where the grid points when nobody is holding a selection for it. */
  const [ownSelection, setOwnSelection] = useState<GridSelection>(cellSelection(0, 0));
  const [menu, setMenu] = useState<{ ordinal: number; x: number; y: number }>();
  const [dragOver, setDragOver] = useState<number>();
  const dragSource = useRef<number | undefined>(undefined);
  const isVisible = (ordinal: number) => !layout?.hidden.has(ordinal);
  const sort = serverSort ? serverSort.sorts[0] : localSort;
  const sortRank = (
    ordinal: number,
  ): { direction: ResultSort["direction"]; rank: number } | undefined => {
    if (serverSort) {
      const index = serverSort.sorts.findIndex((candidate) => candidate.columnIndex === ordinal);
      const item = serverSort.sorts[index];
      return item ? { direction: item.direction, rank: index + 1 } : undefined;
    }
    return localSort?.columnIndex === ordinal
      ? { direction: localSort.direction, rank: 1 }
      : undefined;
  };
  const requestSort = (ordinal: number, additive = false) => {
    if (serverSort) serverSort.onSort(ordinal, additive);
    else setLocalSort((current) => nextResultSort(current, ordinal));
  };
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>({
    clientHeight: RESULT_VIEWPORT_HEIGHT,
    scrollHeight: RESULT_VIEWPORT_HEIGHT,
  });
  const scroller = useRef<HTMLElement>(null);
  const scrollbarDrag = useRef<
    { pointerId: number; startY: number; startScrollTop: number } | undefined
  >(undefined);
  const scrollerId = useId();
  /*
   * Turning the grid writable is an act on the grid, so the grid takes the keystrokes: a reader
   * who opens edit mode and pastes has not clicked a cell, and would otherwise be pasting into
   * the page.
   */
  const editable = Boolean(editing);
  useEffect(() => {
    if (!editable) return;
    clipboard.current?.focus({ preventScroll: true });
    clipboard.current?.select();
  }, [editable]);
  /*
   * Acting on a cell edits it, where its policy allows. Reading one whole is the panel's business,
   * and the panel is the reader's to open — a cell never decides on their behalf that they wanted
   * to see it.
   */
  const activate = (rowIndex: number, ordinal: number, cell: DebugResultCell) => {
    const policy = editing?.policies[ordinal];
    if (policy?.editable && !cell.truncated) setActiveCell({ row: rowIndex, ordinal });
  };
  const columns = keyedValues(
    payload.columns,
    (column) => `${column.name}:${column.dataTypeId}:${column.typeName ?? ""}`,
  ).filter(({ ordinal }) => isVisible(ordinal));
  // What a row spans: the visible columns, plus the gutter — every grid has one.
  const bodyColumnCount = columns.length + 1;
  const rows = useMemo(
    () => (serverSort ? payload.rows : sortedResultRows(payload.rows, sort)),
    [payload.rows, sort, serverSort],
  );
  // Widths stay stable across reloads of the same projection so refresh, sort, and filter do not jump.
  const widthKey = payload.columns.map((column) => `${column.name}:${column.dataTypeId}`).join("|");
  const previousWidths = useRef<{ key: string; widths: number[] }>({ key: "", widths: [] });
  const widths = useMemo(() => {
    const measured = columnWidthsCh(payload.columns, payload.rows);
    const previous = previousWidths.current.key === widthKey ? previousWidths.current.widths : [];
    const merged = measured.map((width, index) => Math.max(width, previous[index] ?? 0));
    previousWidths.current = { key: widthKey, widths: merged };
    return merged;
  }, [payload.columns, payload.rows, widthKey]);
  const start = Math.max(0, Math.floor(scrollTop / RESULT_ROW_HEIGHT) - RESULT_OVERSCAN);
  const viewportHeight = scrollMetrics.clientHeight || RESULT_VIEWPORT_HEIGHT;
  const end = Math.min(
    rows.length,
    start + Math.ceil(viewportHeight / RESULT_ROW_HEIGHT) + RESULT_OVERSCAN * 2,
  );
  const visibleRows = rows.slice(start, end);
  const scrollResetKey = `${payload.navigation?.sessionId ?? "static"}:${payload.navigation?.pageStart ?? 0}:${rows.length}:${sort?.columnIndex ?? -1}:${sort?.direction ?? "source"}`;
  const scrollbar = resultScrollbarGeometry(scrollMetrics, scrollTop);

  /*
   * What a row is called. A page is a window on a result, not a result of its own, so the twentieth
   * row of the second page is the seventieth row — numbering every page from one would say the
   * reader had gone nowhere.
   */
  const firstRowNumber = payload.navigation?.pageStart ?? 1;
  const gridRef = useRef<HTMLTableElement>(null);
  const clipboard = useRef<HTMLTextAreaElement>(null);
  const gridId = useId();
  /** Whether the grid holds the keystrokes, which is what its cursor draws itself for. */
  const [hasFocus, setHasFocus] = useState(false);
  const cellId = (row: number, ordinal: number) => `${gridId}-${row}-${ordinal}`;
  const visibleOrdinals = columns.map((column) => column.ordinal);
  /*
   * A row the reader added sits just over the row it was added on, so the two kinds are
   * interleaved. One index counts through both: clicking, extending and arrowing through them is
   * one mechanism, and the grid never has to ask which of two selections a gesture belonged to.
   */
  const addedRows = editing?.rows?.added ?? [];
  const order = useMemo(() => rowOrder(addedRows, rows.length), [addedRows, rows.length]);
  const selectableRows = order.count;
  /** The rows waiting to be added, gathered under the loaded row each one sits over. */
  const addedOver = useMemo(() => {
    const groups = new Map<number, { added: DataViewRowInsertion; position: number }[]>();
    addedRows.forEach((added, position) => {
      const group = groups.get(added.above) ?? [];
      group.push({ added, position });
      groups.set(added.above, group);
    });
    return groups;
  }, [addedRows]);
  /* Rows added over a row the result has not got: an empty result, or one that has since shrunk. */
  const addedPastTheEnd = addedRows.flatMap((added, position) =>
    added.above >= rows.length ? [{ added, position }] : [],
  );
  /*
   * What the window does not draw, as height. A row waiting to be added takes a place of its own,
   * so the spacers count them too — otherwise the scroll would run short by however many the
   * reader had added above.
   */
  const notDrawnAbove = start + addedRows.filter((added) => added.above < start).length;
  const notDrawnBelow =
    rows.length -
    end +
    addedRows.filter((added) => added.above >= end && added.above < rows.length).length;
  const topSpacer = notDrawnAbove * RESULT_ROW_HEIGHT;
  const bottomSpacer = notDrawnBelow * RESULT_ROW_HEIGHT;
  const held = heldSelection ?? ownSelection;
  const setSelection = (next: GridSelection) => {
    if (onSelect) onSelect(next);
    else setOwnSelection(next);
  };
  /*
   * Selection is keyed by ordinal, like every other position in this grid, so a hidden column
   * never shifts it. Clamping on read means nothing has to reset it when the result changes, and
   * the head is where the roving tabindex and the scroll-into-view follow.
   */
  const inBounds = (at: { row: number; ordinal: number }) => ({
    row: clamp(at.row, 0, selectableRows - 1),
    ordinal: visibleOrdinals.includes(at.ordinal) ? at.ordinal : (visibleOrdinals[0] ?? 0),
  });
  const selection: GridSelection = {
    kind: held.kind,
    anchor: inBounds(held.anchor),
    head: inBounds(held.head),
  };
  /*
   * A reader has to be able to see where they are without hunting for a thin border, so the
   * column header and the row gutter of whatever the selection covers are lit as well. These are
   * the bands the cursor is in.
   */
  /*
   * Only a rectangle of cells has columns to speak of. A selection of whole rows reaches every
   * column, so lighting every heading would say nothing about it; the gutter says it instead.
   */
  const overCells = selection.kind === "cells";
  const ordinalsInSelection = new Set(
    overCells ? selectedOrdinals(selection, visibleOrdinals) : [],
  );
  const rowBand = selectedRows(selection);
  const rowInSelection = (row: number) => row >= rowBand.first && row <= rowBand.last;
  /*
   * The grid is what holds the cursor, so a host tracking it is told what the cursor really is —
   * on the first render, and again whenever a shorter result or a hidden column has clamped it.
   * Otherwise the host would describe one selection while the reader looks at another.
   */
  const reportSelection = onSelect;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the clamped selection is the subject.
  useEffect(() => {
    if (reportSelection && !sameSelection(heldSelection, selection)) reportSelection(selection);
  }, [
    reportSelection,
    heldSelection,
    selection.kind,
    selection.head.row,
    selection.head.ordinal,
    selection.anchor.row,
    selection.anchor.ordinal,
  ]);

  const focus = selection.head;
  const moveTo = (next: { row: number; ordinal: number }) => {
    if (next.row === focus.row && next.ordinal === focus.ordinal) return;
    setSelection(cellSelection(next.row, next.ordinal));
  };
  /**
   * The selection as a spreadsheet would put it on the clipboard. It is written by the one module
   * that writes rows out, in the dialect the paste below reads back.
   */
  const selectionAsText = (): string => {
    const ordinals = selectedOrdinals(selection, visibleOrdinals);
    if (ordinals.length === 0) return "";
    const { first, last } = selectedRows(selection);
    const values = shownValues({
      columns: payload.columns,
      rows,
      order,
      ordinals,
      from: first,
      to: last,
      editFor: editing?.editFor,
    });
    return dataViewExportText(values.columns, values.rows, CLIPBOARD_EXPORT);
  };
  /*
   * The proxy holds one space, always selected. A browser only raises copy when it has something
   * to copy, so the space is what makes Ctrl+C reach the grid at all; `onCopy` then puts the real
   * selection on the clipboard in its place. Nothing ever reads the space.
   */
  const clipboardHolder = " ";
  const focusClipboard = () => {
    const proxy = clipboard.current;
    if (!proxy) return;
    proxy.focus({ preventScroll: true });
    proxy.select();
  };
  /*
   * A press has to leave the keystrokes with the grid. Letting the browser handle it would move
   * the focus to whatever it finds around the cell — in practice the page itself — so the press is
   * refused and the proxy takes the focus instead. A press inside an open editor is left alone:
   * that one is placing a caret in a real field.
   */
  const takeKeys = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    event.preventDefault();
    focusClipboard();
  };
  /*
   * A keystroke lands where the focus is. Re-selecting after every move keeps the proxy ready for
   * the next Ctrl+C, and keeps the focus from drifting back to the page after a paste.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is what has to re-arm it.
  useEffect(() => {
    const proxy = clipboard.current;
    if (proxy && document.activeElement === proxy) proxy.select();
  }, [selection.kind, focus.row, focus.ordinal, selection.anchor.row, selection.anchor.ordinal]);

  /*
   * What a pasted block does to the grid. The browser's own paste event and the fallback that
   * reads the clipboard after a keystroke both end here, so a paste means one thing however it
   * arrived.
   */
  const pastes = useRef(0);
  const applyPastedText = (pasted: string) => {
    if (!editing) return;

    /*
     * A paste lands on the anchor and reads rightwards and downwards from there: one value
     * fills one cell, tab-separated values fill the columns beside it, and each line takes
     * the next row. That is the shape a spreadsheet puts on the clipboard.
     */
    const from = visibleOrdinals.indexOf(selection.anchor.ordinal);
    if (from < 0) return;
    const lines = parseDelimitedText(pasted, "\t");
    const editableHere = (ordinal: number) => editing.policies[ordinal]?.editable === true;
    /*
     * Every line past the last loaded row becomes a row the reader added — a loaded row is
     * never overwritten by a line that had no row of its own — and each row is filled in a
     * single message.
     */
    lines.forEach((line, lineOffset) => {
      const at = selection.anchor.row + lineOffset;
      const values = () => spreadAcross(line, visibleOrdinals, from, payload, editableHere);
      const shown = order.at(at);
      if ("added" in shown) {
        editing.rows?.fill(shown.added.localId, values());
        return;
      }
      const rowIndex = shown.loaded;
      const row = rows[rowIndex];
      if (!row) {
        // A line with no row to land on becomes a row of its own, under the last one.
        editing.rows?.appendPasted(values(), rows.length);
        return;
      }
      line.forEach((value, offset) => {
        const target = visibleOrdinals[from + offset];
        if (target === undefined || !editableHere(target)) return;
        editing.onEdit(row, rowIndex, target, value, row[target]?.value ?? null);
      });
    });
  };

  /*
   * One row the reader added, drawn among the loaded rows rather than in a body of its own: a
   * reader who added it over the fortieth row expects to find it over the fortieth row.
   */
  const addedRowElement = (added: DataViewRowInsertion, shownRow: number) => {
    if (!editing) return null;
    const selectedRow = rowIsSelected(selection, shownRow);
    return (
      <tr key={added.localId} className={`added${selectedRow ? " row-selected" : ""}`}>
        <th
          scope="row"
          className={`row-gutter${selectedRow ? " selected" : ""}${rowInSelection(shownRow) ? " in-selection" : ""}`}
          aria-selected={selectedRow}
          title="New row — click to select it, shift-click to extend"
          onMouseDown={(event) => {
            takeKeys(event);
            const at = { row: shownRow, ordinal: visibleOrdinals[0] ?? 0 };
            setSelection(
              event.shiftKey ? extendedTo(selection, at, "rows") : rowSelection(at.row, at.ordinal),
            );
          }}
        >
          <span className="row-gutter-state added" role="img" aria-label="New row">
            ✚
          </span>
        </th>
        {columns.map(({ key: columnKey, ordinal, value: column }) => {
          const policy = editing.policies[ordinal];
          const shown = added.values[column.name] ?? null;
          const isActive =
            activeAdded?.localId === added.localId && activeAdded.ordinal === ordinal;
          return (
            <td
              key={columnKey}
              id={cellId(shownRow, ordinal)}
              data-added-row={added.localId}
              data-column={ordinal}
              onMouseDown={(event) => {
                takeKeys(event);
                setSelection(
                  event.shiftKey
                    ? extendedTo(selection, { row: shownRow, ordinal }, "cells")
                    : cellSelection(shownRow, ordinal),
                );
              }}
              className={[
                shown === null ? "null" : "",
                policy && !policy.editable ? "read-only" : "",
                isActive ? "editing" : "",
                cellIsSelected(selection, shownRow, ordinal, visibleOrdinals) ? "selected" : "",
                isAnchor(selection, shownRow, ordinal) ? "anchor" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={policy && !policy.editable ? policy.reason : undefined}
              onDoubleClick={() => {
                if (policy?.editable) setActiveAdded({ localId: added.localId, ordinal });
              }}
            >
              {isActive && policy?.editable ? (
                <CellEditor
                  editor={policy.editor}
                  value={shown}
                  onCommit={(next) => {
                    setActiveAdded(undefined);
                    editing.rows?.fill(added.localId, { [column.name]: next });
                  }}
                  onCancel={() => setActiveAdded(undefined)}
                />
              ) : (
                <span className="cell-value">{shown === null ? "DEFAULT" : shown}</span>
              )}
            </td>
          );
        })}
      </tr>
    );
  };

  const step = (rowDelta: number, columnDelta: number, extend: boolean) => {
    setSelection(
      movedSelection(selection, rowDelta, columnDelta, extend, {
        rows: selectableRows,
        visibleOrdinals,
      }),
    );
  };

  // The rows are virtualised, so a cursor that left the window scrolls it back into view. It
  // belongs in an effect: a state updater may run more than once. Rows waiting to be added sit
  // above the window rather than inside it, so only what the window holds can be scrolled to.
  /*
   * The cell the cursor is on, for whatever is showing it whole. A row waiting to be added has no
   * loaded cell behind it, so what it has been filled with stands in for one.
   */
  const cursorCell = ((): DebugResultCell | undefined => {
    const shown = order.at(selection.anchor.row);
    if ("added" in shown) {
      const filled = shown.added.values[payload.columns[selection.anchor.ordinal]?.name ?? ""];
      return {
        kind: filled === undefined || filled === null ? "null" : "text",
        value: filled ?? null,
      };
    }
    const row = rows[shown.loaded];
    const cell = row?.[selection.anchor.ordinal];
    if (!cell) return undefined;
    const edit = editing?.editFor(row ?? [], shown.loaded, selection.anchor.ordinal);
    return edit ? { ...cell, value: edit.value } : cell;
  })();

  const focusedShownRow = order.at(focus.row);
  const loadedFocusRow = "loaded" in focusedShownRow ? focusedShownRow.loaded : -1;
  useEffect(() => {
    const element = scroller.current;
    if (!element || loadedFocusRow < 0) return;
    const top = loadedFocusRow * RESULT_ROW_HEIGHT;
    const viewport = element.clientHeight || RESULT_VIEWPORT_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + RESULT_ROW_HEIGHT > element.scrollTop + viewport) {
      element.scrollTop = top + RESULT_ROW_HEIGHT - viewport;
    }
  }, [loadedFocusRow]);

  useEffect(() => {
    if (!scrollResetKey) return;
    setActiveCell(undefined);
    setScrollTop(0);
    const element = scroller.current;
    element?.scrollTo({ top: 0 });
    if (!element) return;
    const updateMetrics = () => {
      setScrollMetrics({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      });
    };
    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [scrollResetKey]);

  const handleScroll = (event: UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const handleScrollbarPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element || scrollbar.maxScrollTop === 0) return;
    const track = event.currentTarget;
    const clickedThumb =
      event.target instanceof HTMLElement && event.target.classList.contains("result-scroll-thumb");
    if (!clickedThumb) {
      const top = event.clientY - track.getBoundingClientRect().top - scrollbar.thumbHeight / 2;
      element.scrollTop =
        (clamp(top, 0, scrollbar.maxThumbTop) / scrollbar.maxThumbTop) * scrollbar.maxScrollTop;
    }
    scrollbarDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: element.scrollTop,
    };
    track.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleScrollbarPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDrag.current;
    const element = scroller.current;
    if (!drag || drag.pointerId !== event.pointerId || !element || scrollbar.maxThumbTop === 0) {
      return;
    }
    const scrollPerPixel = scrollbar.maxScrollTop / scrollbar.maxThumbTop;
    element.scrollTop = clamp(
      drag.startScrollTop + (event.clientY - drag.startY) * scrollPerPixel,
      0,
      scrollbar.maxScrollTop,
    );
  };

  const stopScrollbarDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (scrollbarDrag.current?.pointerId !== event.pointerId) return;
    scrollbarDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleScrollbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element) return;
    const increments: Partial<Record<string, number>> = {
      ArrowDown: RESULT_ROW_HEIGHT,
      ArrowUp: -RESULT_ROW_HEIGHT,
      PageDown: scrollMetrics.clientHeight,
      PageUp: -scrollMetrics.clientHeight,
      Home: -scrollbar.maxScrollTop,
      End: scrollbar.maxScrollTop,
    };
    const increment = increments[event.key];
    if (increment === undefined) return;
    element.scrollTop = clamp(element.scrollTop + increment, 0, scrollbar.maxScrollTop);
    event.preventDefault();
  };

  return (
    <>
      <div className="result-scroller-frame">
        {/*
          A grid is not an editable element, so a browser fires neither copy nor paste while a
          cell holds the focus: those events go to whatever can hold text. This textarea is that
          thing. It stays out of sight, holds the focus for the grid, and so receives the copy, the
          paste and the arrow keys. `aria-activedescendant` tells a screen reader which cell the
          reader is on.
        */}
        <textarea
          ref={clipboard}
          className="grid-clipboard"
          aria-label="Grid selection"
          aria-controls={gridId}
          aria-activedescendant={cellId(selection.head.row, selection.head.ordinal)}
          value={clipboardHolder}
          onChange={() => {}}
          onBlur={() => setHasFocus(false)}
          onFocus={() => setHasFocus(true)}
          onCopy={(event) => {
            /*
             * The browser's own copy carries the selection. Writing through the Clipboard API
             * instead needs a permission a webview does not always grant, and asking the host to
             * do it puts a round trip between the keystroke and the clipboard.
             */
            const text = selectionAsText();
            if (text === "") return;
            event.clipboardData.setData("text/plain", text);
            event.preventDefault();
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text/plain");
            if (pasted === "") return;
            event.preventDefault();
            pastes.current += 1;
            applyPastedText(pasted);
          }}
          onKeyDown={(event) => {
            const page = Math.floor(viewportHeight / RESULT_ROW_HEIGHT);
            const extend = event.shiftKey;
            const chord = event.metaKey || event.ctrlKey;
            /*
             * Copy is asked for rather than waited for. A browser turns the chord into a copy on
             * its own, but only when it decides the keystroke is an editing command, and a webview
             * driven from outside does not always decide that. Asking for it is the same event,
             * from the same gesture, and it reaches `onCopy` either way.
             */
            if (chord && event.key.toLowerCase() === "c") {
              event.preventDefault();
              document.execCommand("copy");
              return;
            }
            /*
             * Paste cannot be asked for — no page may read the clipboard by command. So the
             * browser's own paste is left to arrive, and only if none did does the grid ask the
             * clipboard for the text itself, which is the path that needs the reader's permission.
             */
            if (chord && event.key.toLowerCase() === "v") {
              const before = pastes.current;
              window.setTimeout(() => {
                if (pastes.current !== before) return;
                navigator.clipboard
                  ?.readText()
                  .then((text) => {
                    if (text !== "") applyPastedText(text);
                  })
                  .catch(() => {});
              }, 0);
              return;
            }
            if (chord && event.key.toLowerCase() === "a") {
              event.preventDefault();
              setSelection(
                extendedTo(rowSelection(0, visibleOrdinals[0] ?? 0), {
                  row: selectableRows - 1,
                  ordinal: visibleOrdinals.at(-1) ?? 0,
                }),
              );
              return;
            }
            switch (event.key) {
              case "ArrowRight":
                step(0, 1, extend);
                break;
              case "ArrowLeft":
                step(0, -1, extend);
                break;
              case "ArrowDown":
                step(1, 0, extend);
                break;
              case "ArrowUp":
                step(-1, 0, extend);
                break;
              case "Escape":
                setSelection(cellSelection(focus.row, focus.ordinal));
                break;
              case "Home":
                moveTo({ row: focus.row, ordinal: columns[0]?.ordinal ?? focus.ordinal });
                break;
              case "End":
                moveTo({ row: focus.row, ordinal: columns.at(-1)?.ordinal ?? focus.ordinal });
                break;
              case "PageDown":
                step(page, 0, extend);
                break;
              case "PageUp":
                step(-page, 0, extend);
                break;
              case "Enter":
              case " ": {
                const cell = rows[focus.row]?.[focus.ordinal];
                if (cell) activate(focus.row, focus.ordinal, cell);
                break;
              }
              default:
                return;
            }
            event.preventDefault();
          }}
        />
        <section
          id={scrollerId}
          className="result-scroller"
          ref={scroller}
          aria-label="Scrollable query results"
          onScroll={handleScroll}
        >
          <table
            ref={gridRef}
            id={gridId}
            // A table's implicit role is `table`; `grid` is the interactive one, and it is what
            // arrow-key navigation over these cells means. `<table role="grid">` is the pattern
            // the ARIA Authoring Practices give for a data grid.
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the grid is navigable.
            role="grid"
            aria-rowcount={rows.length + 1}
            aria-colcount={columns.length + 1}
            className={editing ? "editable" : undefined}
            style={{
              width: `${columns.reduce((total, { ordinal }) => total + (widths[ordinal] ?? 12), 0)}ch`,
            }}
          >
            <colgroup>
              <col className="row-gutter-column" />
              {columns.map(({ key, ordinal }) => (
                <col key={key} style={{ width: `${widths[ordinal] ?? 12}ch` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="row-gutter" aria-label="Rows" />
                {columns.map(({ key, ordinal, value: column }) => (
                  <th
                    key={key}
                    aria-sort={sortRank(ordinal)?.direction}
                    className={[
                      editing?.policies[ordinal]?.editable === false ? "read-only" : "",
                      dragOver === ordinal ? "drag-over" : "",
                      ordinalsInSelection.has(ordinal) ? "in-selection" : "",
                      hasFocus && overCells && selection.anchor.ordinal === ordinal
                        ? "at-cursor"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={
                      layout?.columnAccent?.(ordinal)
                        ? ({ "--column-accent": layout.columnAccent(ordinal) } as CSSProperties)
                        : undefined
                    }
                    draggable={layout ? true : undefined}
                    onDragStart={(event) => {
                      dragSource.current = ordinal;
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", column.name);
                    }}
                    onDragOver={(event) => {
                      if (dragSource.current === undefined) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (dragOver !== ordinal) setDragOver(ordinal);
                    }}
                    onDragLeave={() =>
                      setDragOver((current) => (current === ordinal ? undefined : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = dragSource.current;
                      dragSource.current = undefined;
                      setDragOver(undefined);
                      if (from !== undefined && from !== ordinal) layout?.onReorder(from, ordinal);
                    }}
                    onDragEnd={() => {
                      dragSource.current = undefined;
                      setDragOver(undefined);
                    }}
                    onContextMenu={(event) => {
                      if (!layout) return;
                      event.preventDefault();
                      setMenu({ ordinal, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <button
                      className="column-sort"
                      type="button"
                      title={
                        editing?.policies[ordinal]?.editable === false
                          ? `${editing.policies[ordinal]?.reason} Click to sort by ${column.name}.`
                          : serverSort
                            ? `Sort by ${column.name} in PostgreSQL (Shift+click adds a secondary sort)`
                            : `Sort loaded rows by ${column.name}`
                      }
                      onClick={(event) => requestSort(ordinal, event.shiftKey)}
                    >
                      <span className="column-heading">
                        <span className="column-title">{column.name}</span>
                        <span className="sort-indicator" aria-hidden="true">
                          {(() => {
                            const active = sortRank(ordinal);
                            if (!active) return "↕";
                            const arrow = active.direction === "ascending" ? "↑" : "↓";
                            return serverSort && serverSort.sorts.length > 1
                              ? `${arrow}${active.rank}`
                              : arrow;
                          })()}
                        </span>
                      </span>
                      <small>{column.typeName ?? `oid ${column.dataTypeId}`}</small>
                    </button>
                    {layout ? (
                      <button
                        className="column-menu-button"
                        type="button"
                        title={`Column actions for ${column.name}`}
                        aria-haspopup="menu"
                        onClick={(event) => {
                          event.stopPropagation();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          setMenu({ ordinal, x: bounds.left, y: bounds.bottom });
                        }}
                      >
                        ▾
                      </button>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacer > 0 ? (
                <SpacerRow height={topSpacer} columnCount={bodyColumnCount} />
              ) : null}
              {visibleRows.map((row, visibleIndex) => {
                const rowIndex = start + visibleIndex;
                const removed = editing?.rows?.isRemoved(row) ?? false;
                const selectionRow = order.ofLoaded(rowIndex);
                const selectedRow = rowIsSelected(selection, selectionRow);
                return (
                  <Fragment key={rowIndex}>
                    {(addedOver.get(rowIndex) ?? []).map(({ added, position }) =>
                      addedRowElement(added, order.ofAdded(position)),
                    )}
                    <tr
                      aria-rowindex={firstRowNumber + rowIndex + 1}
                      className={[removed ? "removed" : "", selectedRow ? "row-selected" : ""]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <th
                        scope="row"
                        className={`row-gutter${selectedRow ? " selected" : ""}${rowInSelection(selectionRow) ? " in-selection" : ""}`}
                        aria-selected={selectedRow}
                        title={`Row ${firstRowNumber + rowIndex} — click to select it, shift-click to extend`}
                        onMouseDown={(event) => {
                          takeKeys(event);
                          const at = { row: selectionRow, ordinal: visibleOrdinals[0] ?? 0 };
                          setSelection(
                            event.shiftKey
                              ? extendedTo(selection, at, "rows")
                              : rowSelection(at.row, at.ordinal),
                          );
                        }}
                      >
                        {removed ? (
                          <span
                            className="row-gutter-state removed"
                            role="img"
                            aria-label="Row deleted"
                          >
                            ✕
                          </span>
                        ) : (
                          <span className="row-gutter-number">{firstRowNumber + rowIndex}</span>
                        )}
                      </th>
                      {keyedValues(row, (cell) => `${cell.kind}:${cell.value ?? "NULL"}`)
                        .filter(({ ordinal }) => isVisible(ordinal))
                        .map(({ key: cellKey, ordinal, value: cell }) => {
                          const edit = editing?.editFor(row, rowIndex, ordinal);
                          const shown = edit ? edit.value : cell.value;
                          const value = shown === null ? "NULL" : shown;
                          const policy = editing?.policies[ordinal];
                          const isActive =
                            activeCell?.row === rowIndex && activeCell.ordinal === ordinal;
                          return (
                            <td
                              key={cellKey}
                              id={cellId(selectionRow, ordinal)}
                              data-row={rowIndex}
                              data-column={ordinal}
                              onMouseDown={(event) => {
                                // A click puts the anchor here; a shifted one reaches from where it was.
                                takeKeys(event);
                                setSelection(
                                  event.shiftKey
                                    ? extendedTo(selection, { row: selectionRow, ordinal }, "cells")
                                    : cellSelection(selectionRow, ordinal),
                                );
                              }}
                              className={[
                                shown === null ? "null" : cell.kind === "null" ? "text" : cell.kind,
                                cell.truncated ? "truncated" : "",
                                edit ? "edited" : "",
                                cellIsSelected(selection, selectionRow, ordinal, visibleOrdinals)
                                  ? "selected"
                                  : "",
                                isAnchor(selection, selectionRow, ordinal) ? "anchor" : "",
                                policy && !policy.editable ? "read-only" : "",
                                isActive ? "editing" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              title={
                                edit
                                  ? `Original: ${edit.original ?? "NULL"}`
                                  : policy && !policy.editable
                                    ? policy.reason
                                    : undefined
                              }
                              onDoubleClick={() => {
                                if (editing) activate(rowIndex, ordinal, cell);
                              }}
                            >
                              {isActive && policy?.editable && editing ? (
                                <CellEditor
                                  editor={policy.editor}
                                  value={shown}
                                  onCommit={(next) => {
                                    setActiveCell(undefined);
                                    editing.onEdit(row, rowIndex, ordinal, next, cell.value);
                                  }}
                                  onCancel={() => setActiveCell(undefined)}
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
                                  {value}
                                </a>
                              ) : (
                                <span className="cell-value">{value}</span>
                              )}
                            </td>
                          );
                        })}
                    </tr>
                  </Fragment>
                );
              })}
              {/* Rows added over a row the result has not got sit under the last one it has. */}
              {end >= rows.length
                ? addedPastTheEnd.map(({ added, position }) =>
                    addedRowElement(added, order.ofAdded(position)),
                  )
                : null}
              {bottomSpacer > 0 ? (
                <SpacerRow height={bottomSpacer} columnCount={bodyColumnCount} />
              ) : null}
            </tbody>
          </table>
        </section>
        <div
          className="result-scrollbar"
          role="scrollbar"
          aria-label="Vertical result scroll"
          aria-controls={scrollerId}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(scrollbar.maxScrollTop)}
          aria-valuenow={Math.round(scrollTop)}
          tabIndex={0}
          onKeyDown={handleScrollbarKeyDown}
          onPointerDown={handleScrollbarPointerDown}
          onPointerMove={handleScrollbarPointerMove}
          onPointerUp={stopScrollbarDrag}
          onPointerCancel={stopScrollbarDrag}
        >
          <div
            className="result-scroll-thumb"
            style={
              {
                "--result-scroll-thumb-height": `${scrollbar.thumbHeight}px`,
                "--result-scroll-thumb-top": `${scrollbar.thumbTop}px`,
              } as CSSProperties
            }
          />
        </div>
        {inspecting ? (
          <CellInspector
            column={payload.columns[selection.anchor.ordinal]?.name ?? ""}
            typeName={payload.columns[selection.anchor.ordinal]?.typeName}
            cell={cursorCell}
            onClose={() => onInspecting?.(false)}
          />
        ) : null}
      </div>
      {sort && !serverSort && resultSortNotice(payload) ? (
        <p className="sort-notice">{resultSortNotice(payload)}</p>
      ) : null}
      {menu && layout ? (
        <>
          <button
            type="button"
            className="column-menu-backdrop"
            aria-label="Close column menu"
            onClick={() => setMenu(undefined)}
          />
          <div
            className="column-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            aria-label={`Actions for ${payload.columns[menu.ordinal]?.name ?? "column"}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMenu(undefined);
            }}
          >
            {layout.menuItems(menu.ordinal).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="column-menu-item"
                onClick={() => {
                  setMenu(undefined);
                  item.action();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function resultScrollbarGeometry(
  metrics: ScrollMetrics,
  scrollTop: number,
): ScrollbarGeometry {
  const clientHeight = Math.max(0, metrics.clientHeight);
  const scrollHeight = Math.max(clientHeight, metrics.scrollHeight);
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const thumbHeight =
    maxScrollTop === 0
      ? clientHeight
      : Math.min(
          clientHeight,
          Math.max(RESULT_SCROLLBAR_MIN_THUMB_HEIGHT, (clientHeight * clientHeight) / scrollHeight),
        );
  const maxThumbTop = Math.max(0, clientHeight - thumbHeight);
  const thumbTop =
    maxScrollTop === 0 ? 0 : (clamp(scrollTop, 0, maxScrollTop) / maxScrollTop) * maxThumbTop;
  return { thumbHeight, thumbTop, maxScrollTop, maxThumbTop };
}

/** One pasted line, laid out over the columns from a starting one, by column name. */
/**
 * One pasted line, spread across the columns from where it landed, for a row the reader is adding.
 * A cell the line has nothing in is left out rather than set to an empty string: the clipboard
 * cannot tell an empty text from no text, and a row being added has a third answer — let the
 * database give the column whatever it would have given it.
 */
function spreadAcross(
  line: readonly string[],
  visibleOrdinals: readonly number[],
  from: number,
  payload: ResultTable,
  editable: (ordinal: number) => boolean,
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  line.forEach((value, offset) => {
    const ordinal = visibleOrdinals[from + offset];
    const column = ordinal === undefined ? undefined : payload.columns[ordinal];
    if (column && value !== "" && editable(ordinal as number)) values[column.name] = value;
  });
  return values;
}

function SpacerRow({ height, columnCount }: { height: number; columnCount: number }) {
  return (
    <tr className="result-spacer" aria-hidden="true" tabIndex={-1}>
      <td
        colSpan={columnCount}
        style={{ "--result-spacer-height": `${height}px` } as CSSProperties}
      />
    </tr>
  );
}

interface KeyedValue<T> {
  key: string;
  ordinal: number;
  value: T;
}

function keyedValues<T>(values: readonly T[], fingerprint: (value: T) => string): KeyedValue<T>[] {
  const occurrences = new Map<string, number>();
  return values.map((value, ordinal) => {
    const base = fingerprint(value);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, ordinal, value };
  });
}
