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
import type { DebugResultCell } from "../../../src/debugger/launch/index.js";
import type { SqlNotebookResultPayload } from "../sqlNotebookModel.js";
import {
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
  payload: SqlNotebookResultPayload;
}

export function ResultGrid({ payload }: ResultGridProps) {
  const [detail, setDetail] = useState<string>();
  const [sort, setSort] = useState<ResultSort>();
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
  const columns = keyedValues(
    payload.columns,
    (column) => `${column.name}:${column.dataTypeId}:${column.typeName ?? ""}`,
  );
  const rows = useMemo(() => sortedResultRows(payload.rows, sort), [payload.rows, sort]);
  const start = Math.max(0, Math.floor(scrollTop / RESULT_ROW_HEIGHT) - RESULT_OVERSCAN);
  const end = Math.min(
    rows.length,
    start + Math.ceil(RESULT_VIEWPORT_HEIGHT / RESULT_ROW_HEIGHT) + RESULT_OVERSCAN * 2,
  );
  const visibleRows = rows.slice(start, end);
  const topSpacer = start * RESULT_ROW_HEIGHT;
  const bottomSpacer = (rows.length - end) * RESULT_ROW_HEIGHT;
  const scrollResetKey = `${payload.navigation?.sessionId ?? "static"}:${payload.navigation?.pageStart ?? 0}:${rows.length}:${sort?.columnIndex ?? -1}:${sort?.direction ?? "source"}`;
  const scrollbar = resultScrollbarGeometry(scrollMetrics, scrollTop);

  useEffect(() => {
    if (!scrollResetKey) return;
    setDetail(undefined);
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
          <table aria-rowcount={rows.length + 1}>
            <thead>
              <tr>
                {columns.map(({ key, ordinal, value: column }) => (
                  <th
                    key={key}
                    aria-sort={sort?.columnIndex === ordinal ? sort.direction : undefined}
                  >
                    <button
                      className="column-sort"
                      type="button"
                      title={`Sort loaded rows by ${column.name}`}
                      onClick={() => setSort((current) => nextResultSort(current, ordinal))}
                    >
                      <span className="column-heading">
                        <span className="column-title">{column.name}</span>
                        <span className="sort-indicator" aria-hidden="true">
                          {sort?.columnIndex === ordinal
                            ? sort.direction === "ascending"
                              ? "↑"
                              : "↓"
                            : "↕"}
                        </span>
                      </span>
                      <small>{column.typeName ?? `oid ${column.dataTypeId}`}</small>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacer > 0 ? <SpacerRow height={topSpacer} columnCount={columns.length} /> : null}
              {visibleRows.map((row, visibleIndex) => {
                const rowIndex = start + visibleIndex;
                return (
                  <tr key={rowIndex} aria-rowindex={rowIndex + 2}>
                    {keyedValues(row, (cell) => `${cell.kind}:${cell.value ?? "NULL"}`).map(
                      ({ key: cellKey, ordinal, value: cell }) => {
                        const value = cell.value === null ? "NULL" : cell.value;
                        const inspectable =
                          cell.kind === "json" || cell.kind === "binary" || cell.truncated;
                        return (
                          <td
                            key={cellKey}
                            className={[cell.kind, cell.truncated ? "truncated" : ""]
                              .filter(Boolean)
                              .join(" ")}
                          >
                            {inspectable ? (
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
                      },
                    )}
                  </tr>
                );
              })}
              {bottomSpacer > 0 ? (
                <SpacerRow height={bottomSpacer} columnCount={columns.length} />
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
      {sort && resultSortNotice(payload) ? (
        <p className="sort-notice">{resultSortNotice(payload)}</p>
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
