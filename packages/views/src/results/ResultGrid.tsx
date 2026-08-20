import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { clamp } from "../../../rows/src/clamp.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { CellEditor, type GridEditing } from "./CellEditor.js";
import {
  columnWidthsCh,
  formattedCellValue,
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

export interface ResultGridProps {
  /** Only the table: a grid never needed the Connexion or the Statement behind it. */
  payload: ResultTable;
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

export function ResultGrid({ payload, serverSort, editing, layout }: ResultGridProps) {
  const [detail, setDetail] = useState<string>();
  const [localSort, setLocalSort] = useState<ResultSort>();
  const [activeCell, setActiveCell] = useState<{ row: number; ordinal: number }>();
  /** The one cell the grid keeps reachable with a single Tab; arrows move it. */
  const [focusCell, setFocusCell] = useState<{ row: number; ordinal: number }>({
    row: 0,
    ordinal: 0,
  });
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
  const detailElement = useRef<HTMLPreElement>(null);
  const scrollbarDrag = useRef<
    { pointerId: number; startY: number; startScrollTop: number } | undefined
  >(undefined);
  const scrollerId = useId();
  const detailId = useId();
  const inspect = (cell: DebugResultCell) => setDetail(formattedCellValue(cell));
  /** Acting on a cell: edit it when its policy allows, otherwise show what it holds. */
  const activate = (rowIndex: number, ordinal: number, cell: DebugResultCell) => {
    const policy = editing?.policies[ordinal];
    if (policy?.editable && !cell.truncated) setActiveCell({ row: rowIndex, ordinal });
    else inspect(cell);
  };
  const columns = keyedValues(
    payload.columns,
    (column) => `${column.name}:${column.dataTypeId}:${column.typeName ?? ""}`,
  ).filter(({ ordinal }) => isVisible(ordinal));
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
  const topSpacer = start * RESULT_ROW_HEIGHT;
  const bottomSpacer = (rows.length - end) * RESULT_ROW_HEIGHT;
  const scrollResetKey = `${payload.navigation?.sessionId ?? "static"}:${payload.navigation?.pageStart ?? 0}:${rows.length}:${sort?.columnIndex ?? -1}:${sort?.direction ?? "source"}`;
  const scrollbar = resultScrollbarGeometry(scrollMetrics, scrollTop);

  const gridRef = useRef<HTMLTableElement>(null);
  // Focus is keyed by ordinal, like every other position in this grid, so a hidden column never
  // shifts it. Clamping on read means nothing has to reset it when the result changes.
  const focus = {
    row: clamp(focusCell.row, 0, rows.length - 1),
    ordinal: columns.some(({ ordinal }) => ordinal === focusCell.ordinal)
      ? focusCell.ordinal
      : (columns[0]?.ordinal ?? 0),
  };
  const moveTo = (next: { row: number; ordinal: number }) => {
    if (next.row === focus.row && next.ordinal === focus.ordinal) return;
    setFocusCell(next);
  };
  const step = (rowDelta: number, columnDelta: number) => {
    const index = columns.findIndex(({ ordinal }) => ordinal === focus.ordinal);
    const column = clamp(index + columnDelta, 0, columns.length - 1);
    moveTo({
      row: clamp(focus.row + rowDelta, 0, rows.length - 1),
      ordinal: columns[column]?.ordinal ?? focus.ordinal,
    });
  };

  // The rows are virtualised, so a focus that left the window scrolls it back into view and takes
  // the cell once it exists. Both belong in an effect: a state updater may run more than once.
  useEffect(() => {
    const element = scroller.current;
    if (element) {
      const top = focus.row * RESULT_ROW_HEIGHT;
      const viewport = element.clientHeight || RESULT_VIEWPORT_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + RESULT_ROW_HEIGHT > element.scrollTop + viewport) {
        element.scrollTop = top + RESULT_ROW_HEIGHT - viewport;
      }
    }
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `td[data-row="${focus.row}"][data-column="${focus.ordinal}"]`,
    );
    if (cell && gridRef.current?.contains(document.activeElement)) cell.focus();
  }, [focus.row, focus.ordinal]);

  useEffect(() => {
    if (!scrollResetKey) return;
    setDetail(undefined);
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

  useEffect(() => {
    if (detail !== undefined) detailElement.current?.focus();
  }, [detail]);

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
        <section
          id={scrollerId}
          className="result-scroller"
          ref={scroller}
          aria-label="Scrollable query results"
          onScroll={handleScroll}
        >
          <table
            ref={gridRef}
            // A table's implicit role is `table`; `grid` is the interactive one, and it is what
            // arrow-key navigation over these cells means. `<table role="grid">` is the pattern
            // the ARIA Authoring Practices give for a data grid.
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the grid is navigable.
            role="grid"
            aria-rowcount={rows.length + 1}
            aria-colcount={columns.length}
            className={editing ? "editable" : undefined}
            onKeyDown={(event) => {
              const page = Math.floor(viewportHeight / RESULT_ROW_HEIGHT);
              switch (event.key) {
                case "ArrowRight":
                  step(0, 1);
                  break;
                case "ArrowLeft":
                  step(0, -1);
                  break;
                case "ArrowDown":
                  step(1, 0);
                  break;
                case "ArrowUp":
                  step(-1, 0);
                  break;
                case "Home":
                  moveTo({ row: focus.row, ordinal: columns[0]?.ordinal ?? focus.ordinal });
                  break;
                case "End":
                  moveTo({ row: focus.row, ordinal: columns.at(-1)?.ordinal ?? focus.ordinal });
                  break;
                case "PageDown":
                  step(page, 0);
                  break;
                case "PageUp":
                  step(-page, 0);
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
            style={{
              width: `${columns.reduce((total, { ordinal }) => total + (widths[ordinal] ?? 12), 0)}ch`,
            }}
          >
            <colgroup>
              {editing?.rows ? <col className="row-gutter-column" /> : null}
              {columns.map(({ key, ordinal }) => (
                <col key={key} style={{ width: `${widths[ordinal] ?? 12}ch` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {editing?.rows ? <th className="row-gutter" aria-label="Rows" /> : null}
                {columns.map(({ key, ordinal, value: column }) => (
                  <th
                    key={key}
                    aria-sort={sortRank(ordinal)?.direction}
                    className={[
                      editing?.policies[ordinal]?.editable === false ? "read-only" : "",
                      dragOver === ordinal ? "drag-over" : "",
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
                <SpacerRow
                  height={topSpacer}
                  columnCount={columns.length + (editing?.rows ? 1 : 0)}
                />
              ) : null}
              {visibleRows.map((row, visibleIndex) => {
                const rowIndex = start + visibleIndex;
                const removed = editing?.rows?.isRemoved(row, rowIndex) ?? false;
                return (
                  <tr
                    key={rowIndex}
                    aria-rowindex={rowIndex + 2}
                    className={removed ? "removed" : undefined}
                  >
                    {editing?.rows ? (
                      <td className="row-gutter">
                        <button
                          type="button"
                          className="row-gutter-action"
                          title={
                            removed
                              ? "Keep this row after all"
                              : "Take this row away when the changes are applied"
                          }
                          aria-label={
                            removed ? `Keep row ${rowIndex + 1}` : `Remove row ${rowIndex + 1}`
                          }
                          onClick={() => editing.rows?.toggleRemoval(row, rowIndex)}
                        >
                          <span
                            className={`codicon codicon-${removed ? "discard" : "remove"}`}
                            aria-hidden="true"
                          />
                        </button>
                      </td>
                    ) : null}
                    {keyedValues(row, (cell) => `${cell.kind}:${cell.value ?? "NULL"}`)
                      .filter(({ ordinal }) => isVisible(ordinal))
                      .map(({ key: cellKey, ordinal, value: cell }) => {
                        const edit = editing?.editFor(row, rowIndex, ordinal);
                        const shown = edit ? edit.value : cell.value;
                        const value = shown === null ? "NULL" : shown;
                        const inspectable =
                          !editing &&
                          (cell.kind === "json" || cell.kind === "binary" || cell.truncated);
                        const policy = editing?.policies[ordinal];
                        const isActive =
                          activeCell?.row === rowIndex && activeCell.ordinal === ordinal;
                        const isFocused = focus.row === rowIndex && focus.ordinal === ordinal;
                        return (
                          <td
                            key={cellKey}
                            tabIndex={isFocused ? 0 : -1}
                            data-row={rowIndex}
                            data-column={ordinal}
                            onFocus={() => moveTo({ row: rowIndex, ordinal })}
                            className={[
                              shown === null ? "null" : cell.kind === "null" ? "text" : cell.kind,
                              cell.truncated ? "truncated" : "",
                              edit ? "edited" : "",
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
                            ) : inspectable ? (
                              <button
                                className="cell-value inspectable"
                                type="button"
                                title={`Inspect ${payload.columns[ordinal]?.name ?? "value"}`}
                                aria-controls={detailId}
                                onClick={() => inspect(cell)}
                              >
                                {value}
                              </button>
                            ) : (
                              <span className="cell-value">{value}</span>
                            )}
                          </td>
                        );
                      })}
                  </tr>
                );
              })}
              {bottomSpacer > 0 ? (
                <SpacerRow
                  height={bottomSpacer}
                  columnCount={columns.length + (editing?.rows ? 1 : 0)}
                />
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
      {detail === undefined ? null : (
        <pre
          id={detailId}
          ref={detailElement}
          className="result-detail"
          role="status"
          aria-label="Inspected cell value"
          tabIndex={-1}
        >
          {detail}
        </pre>
      )}
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
