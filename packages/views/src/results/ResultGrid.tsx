import {
  type CSSProperties,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { clamp } from "../../../rows/src/clamp.js";
import type {
  DataViewColumnPolicy,
  DataViewEdit,
  DataViewRowInsertion,
} from "../../../rows/src/dataView/dataView.js";
import { rowOrder } from "../../../rows/src/dataView/rowOrder.js";
import { shownValues } from "../../../rows/src/dataView/shownValues.js";
import {
  CLIPBOARD_EXPORT,
  dataViewExportText,
  parseDelimitedText,
} from "../../../rows/src/export.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { CellInspector } from "./CellInspector.js";
import { followCellLink, isWebAddress } from "./cellDetail.js";
import { matchFrom, matchingCells } from "./findInRows.js";
import { GridFinder } from "./GridFinder.js";
import { GridHeader } from "./GridHeader.js";
import { GridRow, type GridRowContext } from "./GridRow.js";
import {
  cellIsSelected,
  cellSelection,
  extendedTo,
  type GridSelection,
  movedSelection,
  rowSelection,
  sameSelection,
  selectedOrdinals,
  selectedRows,
} from "./gridSelection.js";
import { anchorUnder, Menu, type MenuEntry, type OpenMenu, useMenu } from "./Menu.js";
import { ResultScrollbar, type ScrollMetrics } from "./ResultScrollbar.js";
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
  /** What the surface around the grid offers on one column heading. */
  columnMenu(ordinal: number): MenuEntry[];
  /**
   * What it offers on one cell — filtering on what it holds, and whatever else only that surface
   * can do. The grid adds what it can do itself.
   */
  cellMenu?(ordinal: number, value: string | null): MenuEntry[];
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
  const menu = useMenu();
  /*
   * The width a reader has chosen for a column, where they have chosen one. A column nobody has
   * touched keeps the width its content asks for, so a result that changes shape still fits.
   */
  const [chosenWidths, setChosenWidths] = useState<Record<number, number>>({});
  /* What the reader is looking for among the rows on screen; absent when they are not looking. */
  const [looking, setLooking] = useState<string>();
  const setChosenWidth = (ordinal: number, widthCh: number) =>
    setChosenWidths((current) => ({ ...current, [ordinal]: widthCh }));
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
  const measuredWidths = useMemo(() => {
    const measured = columnWidthsCh(payload.columns, payload.rows);
    const previous = previousWidths.current.key === widthKey ? previousWidths.current.widths : [];
    const merged = measured.map((width, index) => Math.max(width, previous[index] ?? 0));
    previousWidths.current = { key: widthKey, widths: merged };
    return merged;
  }, [payload.columns, payload.rows, widthKey]);
  /* What each column is actually drawn at: what the reader asked for, or what the content asks. */
  const widths = useMemo(
    () => measuredWidths.map((width, ordinal) => chosenWidths[ordinal] ?? width),
    [measuredWidths, chosenWidths],
  );
  const start = Math.max(0, Math.floor(scrollTop / RESULT_ROW_HEIGHT) - RESULT_OVERSCAN);
  const viewportHeight = scrollMetrics.clientHeight || RESULT_VIEWPORT_HEIGHT;
  const end = Math.min(
    rows.length,
    start + Math.ceil(viewportHeight / RESULT_ROW_HEIGHT) + RESULT_OVERSCAN * 2,
  );
  const visibleRows = rows.slice(start, end);
  const scrollResetKey = `${payload.navigation?.sessionId ?? "static"}:${payload.navigation?.pageStart ?? 0}:${rows.length}:${sort?.columnIndex ?? -1}:${sort?.direction ?? "source"}`;

  /*
   * What a row is called. A page is a window on a result, not a result of its own, so the twentieth
   * row of the second page is the seventieth row — numbering every page from one would say the
   * reader had gone nowhere.
   */
  const firstRowNumber = payload.navigation?.pageStart ?? 1;
  /*
   * How wide the gutter has to be: the longest number it will show. A fixed width clips the row
   * numbers of any result past ninety-nine, and a reader who has paged to row four thousand is
   * exactly the reader who needs to read it.
   */
  const rowNumberWidth = `${String(firstRowNumber + Math.max(0, rows.length - 1)).length}ch`;
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
  /** The copy a reader asks for by menu is the copy Ctrl+C makes: the same event, the same text. */
  const copySelection = () => {
    focusClipboard();
    document.execCommand("copy");
  };
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
   * What the reader is looking for, over the rows the grid holds — which is a page of a result and
   * not the whole of it. It matches what the grid draws, edits and rows waiting to be added
   * included, by asking the one module that says what a row shows. Built only while they are
   * looking: a result that has been loaded whole holds a great many rows.
   */
  const ordinalsKey = visibleOrdinals.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ordinals are keyed by their order.
  const matches = useMemo(() => {
    if (!looking || order.count === 0) return [];
    const values = shownValues({
      columns: payload.columns,
      rows,
      order,
      ordinals: visibleOrdinals,
      from: 0,
      to: order.count - 1,
      editFor: editing?.editFor,
    });
    return matchingCells(values.rows, looking);
  }, [looking, rows, order, payload.columns, ordinalsKey, editing?.editFor]);
  /* Which match the cursor is on, if it is on one: the cursor is the answer, not a second state. */
  const matchOrdinal = (match: { column: number }) => visibleOrdinals[match.column] ?? 0;
  const currentMatch = matches.findIndex(
    (match) =>
      match.row === selection.anchor.row && matchOrdinal(match) === selection.anchor.ordinal,
  );
  const matchedCells = new Set(matches.map((match) => `${match.row}:${matchOrdinal(match)}`));
  const stepMatch = (direction: 1 | -1) => {
    const at = {
      row: selection.anchor.row,
      column: Math.max(0, visibleOrdinals.indexOf(selection.anchor.ordinal)),
    };
    const next = matchFrom(matches, at, direction);
    const match = next === undefined ? undefined : matches[next];
    if (match) setSelection(cellSelection(match.row, matchOrdinal(match)));
  };
  /*
   * Typing moves the cursor onto a match, so a reader sees where they are as they type. Only when
   * it is not on one already: stepping through matches must not be undone by the next render.
   */
  const stepToMatch = stepMatch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the matches are the subject.
  useEffect(() => {
    if (matches.length > 0 && currentMatch < 0) stepToMatch(1);
  }, [matches]);

  /**
   * What the menu for one cell offers: what the caller says, plus the two things the grid itself
   * can do with a cell — follow what it holds, when that is an address, and copy what is selected.
   */
  const cellMenuFor = (
    shownRow: number,
    ordinal: number,
    value: string | null,
  ): Omit<OpenMenu, "at"> => {
    const offered = layout?.cellMenu?.(ordinal, value) ?? [];
    return {
      label: `Actions for ${payload.columns[ordinal]?.name ?? "cell"}`,
      entries: [
        /*
         * The link the cell already draws is the one that opens: a click on it is the gesture the
         * host knows how to answer, and going around it would be a second way of following a link.
         */
        ...(value !== null && isWebAddress(value)
          ? [
              {
                kind: "action" as const,
                label: "Open",
                run: () => followCellLink(document.getElementById(cellId(shownRow, ordinal))),
              },
            ]
          : []),
        ...offered,
        ...(offered.length > 0 ? [{ kind: "separator" as const }] : []),
        { kind: "action", label: "Copy", run: () => copySelection() },
      ],
    };
  };
  /** A menu acts on the cell it was asked for, so asking for one puts the cursor there. */
  const aimAt = (shownRow: number, ordinal: number) => {
    if (!cellIsSelected(selection, shownRow, ordinal, visibleOrdinals)) {
      setSelection(cellSelection(shownRow, ordinal));
    }
    focusClipboard();
  };

  /*
   * Everything a row needs to draw itself and to answer a gesture. One object, built once: a row
   * of a result and a row the reader is adding differ in three answers, not in three hundred
   * lines, and they used to drift apart because they were written twice.
   */
  const rowContext: GridRowContext = {
    columns,
    visibleOrdinals,
    selection,
    setSelection,
    takeKeys,
    cellId,
    matched: matchedCells,
    ...(editing ? { editing } : {}),
    onCellMenu(event, shownRow, ordinal, value) {
      aimAt(shownRow, ordinal);
      menu.open(event, cellMenuFor(shownRow, ordinal, value));
    },
    isEditingCell(subject, ordinal) {
      return subject.of === "added"
        ? activeAdded?.localId === subject.added.localId && activeAdded.ordinal === ordinal
        : activeCell?.row === subject.loadedIndex && activeCell.ordinal === ordinal;
    },
    openEditor(subject, ordinal, cell) {
      const policy = editing?.policies[ordinal];
      if (!policy?.editable) return;
      if (subject.of === "added") {
        setActiveAdded({ localId: subject.added.localId, ordinal });
        return;
      }
      // A value cut short on its way here is not a value to edit: writing it back would truncate it.
      if (!cell.truncated) setActiveCell({ row: subject.loadedIndex, ordinal });
    },
    closeEditor() {
      setActiveCell(undefined);
      setActiveAdded(undefined);
    },
  };

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
            /*
             * The menu a right click opens, opened by the keys every desktop uses for it. It goes
             * under the cell the cursor is on, which is the cell it acts on.
             */
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              /* The cell the box is drawn around, which is the one the inspector reads too. */
              const on = selection.anchor;
              const cell = document.getElementById(cellId(on.row, on.ordinal));
              aimAt(on.row, on.ordinal);
              menu.openAt(
                cell ? anchorUnder(cell) : { x: 0, y: 0 },
                cellMenuFor(on.row, on.ordinal, cursorCell?.value ?? null),
              );
              return;
            }
            if (chord && event.key.toLowerCase() === "f") {
              event.preventDefault();
              setLooking((current) => current ?? "");
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
                if (looking !== undefined) setLooking(undefined);
                else setSelection(cellSelection(focus.row, focus.ordinal));
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
            style={
              {
                width: `${columns.reduce((total, { ordinal }) => total + (widths[ordinal] ?? 12), 0)}ch`,
                "--row-number-width": rowNumberWidth,
              } as CSSProperties
            }
          >
            <colgroup>
              <col className="row-gutter-column" />
              {columns.map(({ key, ordinal }) => (
                <col key={key} style={{ width: `${widths[ordinal] ?? 12}ch` }} />
              ))}
            </colgroup>
            <GridHeader
              columns={columns}
              policies={editing?.policies}
              layout={layout}
              serverSort={serverSort}
              sortRank={sortRank}
              onSort={requestSort}
              widths={widths}
              onResize={setChosenWidth}
              onResetWidth={(ordinal) =>
                setChosenWidths((current) => {
                  const next = { ...current };
                  delete next[ordinal];
                  return next;
                })
              }
              ordinalsInSelection={ordinalsInSelection}
              cursorOrdinal={hasFocus && overCells ? selection.anchor.ordinal : undefined}
              onMenu={(ordinal, at) =>
                menu.openAt(at, {
                  label: `Actions for ${payload.columns[ordinal]?.name ?? "column"}`,
                  entries: layout?.columnMenu(ordinal) ?? [],
                })
              }
            />
            <tbody>
              {topSpacer > 0 ? (
                <SpacerRow height={topSpacer} columnCount={bodyColumnCount} />
              ) : null}
              {visibleRows.map((row, visibleIndex) => {
                const rowIndex = start + visibleIndex;
                return (
                  <Fragment key={rowIndex}>
                    {(addedOver.get(rowIndex) ?? []).map(({ added, position }) => (
                      <GridRow
                        key={added.localId}
                        subject={{ of: "added", added }}
                        shownRow={order.ofAdded(position)}
                        context={rowContext}
                      />
                    ))}
                    <GridRow
                      subject={{
                        of: "loaded",
                        cells: row,
                        loadedIndex: rowIndex,
                        number: firstRowNumber + rowIndex,
                        removed: editing?.rows?.isRemoved(row) ?? false,
                      }}
                      shownRow={order.ofLoaded(rowIndex)}
                      context={rowContext}
                    />
                  </Fragment>
                );
              })}
              {/* Rows added over a row the result has not got sit under the last one it has. */}
              {end >= rows.length
                ? addedPastTheEnd.map(({ added, position }) => (
                    <GridRow
                      key={added.localId}
                      subject={{ of: "added", added }}
                      shownRow={order.ofAdded(position)}
                      context={rowContext}
                    />
                  ))
                : null}
              {bottomSpacer > 0 ? (
                <SpacerRow height={bottomSpacer} columnCount={bodyColumnCount} />
              ) : null}
            </tbody>
          </table>
        </section>
        {looking !== undefined ? (
          <GridFinder
            looking={looking}
            onLooking={setLooking}
            matchCount={matches.length}
            current={currentMatch < 0 ? undefined : currentMatch + 1}
            onStep={stepMatch}
            onClose={() => {
              setLooking(undefined);
              focusClipboard();
            }}
          />
        ) : null}
        <ResultScrollbar
          scroller={scroller}
          scrollTop={scrollTop}
          metrics={scrollMetrics}
          controls={scrollerId}
          rowHeight={RESULT_ROW_HEIGHT}
        />
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
      {menu.menu ? <Menu {...menu.menu} onClose={menu.close} /> : null}
    </>
  );
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
