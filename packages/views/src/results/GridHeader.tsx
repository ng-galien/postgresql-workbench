import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import type { DebugResultColumn } from "../../../dap/src/debugger/launch/index.js";
import { clamp } from "../../../rows/src/clamp.js";
import type { DataViewColumnPolicy } from "../../../rows/src/dataView/dataView.js";
import type { GridLayout } from "./ResultGrid.js";
import type { ResultSort } from "./resultFormatting.js";

/** What a column may be narrowed to, and stretched to, in characters. */
const NARROWEST = 3;
const WIDEST = 200;

export interface HeaderColumn {
  key: string;
  ordinal: number;
  value: DebugResultColumn;
}

/**
 * The row of column headings: what each column is called, what it holds, how it is ordered, where
 * it sits and how wide it is. Everything here acts on a column and on nothing else — no row of the
 * result is reachable from it — which is why it is the whole of one file.
 */
export function GridHeader({
  columns,
  policies,
  layout,
  serverSort,
  sortRank,
  onSort,
  widths,
  onResize,
  onResetWidth,
  ordinalsInSelection,
  cursorOrdinal,
  onMenu,
}: {
  columns: readonly HeaderColumn[];
  policies?: readonly DataViewColumnPolicy[];
  layout?: GridLayout;
  /** Present when ordering is PostgreSQL's to do, which changes what a heading promises. */
  serverSort?: { sorts: readonly ResultSort[] };
  sortRank(ordinal: number): { direction: ResultSort["direction"]; rank: number } | undefined;
  onSort(ordinal: number, additive: boolean): void;
  /** The width each column is drawn at, in characters. */
  widths: readonly number[];
  onResize(ordinal: number, widthCh: number): void;
  /** Gives a column back the width its content asks for. */
  onResetWidth(ordinal: number): void;
  /** The columns the selection covers, lit so a reader can see where they are. */
  ordinalsInSelection: ReadonlySet<number>;
  /** The column the cursor is in, when the grid holds the keystrokes and holds cells. */
  cursorOrdinal?: number;
  onMenu(ordinal: number, at: { x: number; y: number }): void;
}) {
  const dragSource = useRef<number | undefined>(undefined);
  /* Which column the drag is over. Local, so moving a column redraws headings and not the rows. */
  const [dragOver, setDragOver] = useState<number>();
  /* A resize is a pointer gesture on one column: what it started from, and what a character costs. */
  const resize = useRef<{ ordinal: number; startX: number; startCh: number; pxPerCh: number }>(
    undefined,
  );

  return (
    <thead>
      <tr>
        <th className="row-gutter" aria-label="Rows" />
        {columns.map(({ key, ordinal, value: column }) => {
          const policy = policies?.[ordinal];
          const accent = layout?.columnAccent?.(ordinal);
          return (
            <th
              key={key}
              aria-sort={sortRank(ordinal)?.direction}
              className={[
                policy?.editable === false ? "read-only" : "",
                dragOver === ordinal ? "drag-over" : "",
                ordinalsInSelection.has(ordinal) ? "in-selection" : "",
                cursorOrdinal === ordinal ? "at-cursor" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={accent ? ({ "--column-accent": accent } as CSSProperties) : undefined}
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
                onMenu(ordinal, { x: event.clientX, y: event.clientY });
              }}
            >
              <button
                className="column-sort"
                type="button"
                title={
                  policy?.editable === false
                    ? `${policy.reason} Click to sort by ${column.name}.`
                    : serverSort
                      ? `Sort by ${column.name} in PostgreSQL (Shift+click adds a secondary sort)`
                      : `Sort loaded rows by ${column.name}`
                }
                onClick={(event) => onSort(ordinal, event.shiftKey)}
              >
                <span className="column-heading">
                  <span className="column-title">{column.name}</span>
                  <span className="sort-indicator" aria-hidden="true">
                    {sortIndicator(sortRank(ordinal), serverSort?.sorts.length ?? 0)}
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
                    onMenu(ordinal, { x: bounds.left, y: bounds.bottom });
                  }}
                >
                  ▾
                </button>
              ) : null}
              {/*
               * The edge of a column, to take hold of — the splitter pattern, so it is reachable by
               * keyboard too: the arrows widen and narrow, and Escape gives the column back the
               * width its content asks for, which double-clicking also does.
               */}
              {/* biome-ignore lint/a11y/useSemanticElements: a splitter is a separator you drag,
                  not a thematic break; <hr> is void and carries the wrong meaning. */}
              <span
                className="column-resize"
                role="separator"
                tabIndex={0}
                /*
                 * The heading itself is draggable — that is how a column is moved — and a press on
                 * this edge would start that drag instead of this one. Refusing it here is what
                 * keeps the two gestures apart: hold the edge to resize, hold the heading to move.
                 */
                draggable={false}
                onDragStart={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                aria-orientation="vertical"
                aria-label={`Width of ${column.name}, in characters`}
                aria-valuenow={widths[ordinal] ?? 0}
                aria-valuemin={NARROWEST}
                aria-valuemax={WIDEST}
                title={`Drag to resize ${column.name}; double-click to fit its content`}
                onDoubleClick={() => onResetWidth(ordinal)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    onResetWidth(ordinal);
                    event.preventDefault();
                    return;
                  }
                  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (step === 0) return;
                  const by = event.shiftKey ? step * 8 : step;
                  onResize(ordinal, clamp((widths[ordinal] ?? 12) + by, NARROWEST, WIDEST));
                  event.preventDefault();
                }}
                onPointerDown={(event: PointerEvent<HTMLSpanElement>) => {
                  const heading = event.currentTarget.parentElement;
                  const startCh = widths[ordinal] ?? 12;
                  if (!heading || startCh <= 0) return;
                  resize.current = {
                    ordinal,
                    startX: event.clientX,
                    startCh,
                    // What one character is worth here, measured rather than assumed: the grid is
                    // sized in `ch`, and only the heading itself knows what that is on screen.
                    pxPerCh: heading.getBoundingClientRect().width / startCh,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerMove={(event: PointerEvent<HTMLSpanElement>) => {
                  const held = resize.current;
                  if (!held || held.pxPerCh <= 0) return;
                  const moved = (event.clientX - held.startX) / held.pxPerCh;
                  onResize(
                    held.ordinal,
                    clamp(Math.round(held.startCh + moved), NARROWEST, WIDEST),
                  );
                }}
                onPointerUp={(event: PointerEvent<HTMLSpanElement>) => {
                  resize.current = undefined;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  resize.current = undefined;
                }}
              />
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

/** Which way a column is ordered, and where it comes in the order when there is more than one. */
function sortIndicator(
  active: { direction: ResultSort["direction"]; rank: number } | undefined,
  sortCount: number,
): string {
  if (!active) return "↕";
  const arrow = active.direction === "ascending" ? "↑" : "↓";
  return sortCount > 1 ? `${arrow}${active.rank}` : arrow;
}
