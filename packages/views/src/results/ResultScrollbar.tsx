import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from "react";
import { clamp } from "../../../rows/src/clamp.js";

/** How tall the thumb may never go below, or a long result leaves nothing to take hold of. */
const MIN_THUMB_HEIGHT = 24;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
}

export interface ScrollbarGeometry {
  thumbHeight: number;
  thumbTop: number;
  maxScrollTop: number;
  maxThumbTop: number;
}

/**
 * The scrollbar of a result, drawn rather than the browser's own.
 *
 * A result scrolls a window over rows that are not all drawn, so the browser's bar would size its
 * thumb against the spacers rather than against the rows. This one is sized from the metrics the
 * grid measures, and it is reachable by keyboard, which an overlay bar is not.
 */
export function ResultScrollbar({
  scroller,
  scrollTop,
  metrics,
  controls,
  rowHeight,
}: {
  /** The element that actually scrolls; this bar moves it and never holds the position itself. */
  scroller: RefObject<HTMLElement | null>;
  scrollTop: number;
  metrics: ScrollMetrics;
  /** The id of the scrolled region, for a reader who arrives here by keyboard. */
  controls: string;
  /** One notch of the arrow keys: a row, because that is what a reader is counting. */
  rowHeight: number;
}) {
  const geometry = resultScrollbarGeometry(metrics, scrollTop);
  const drag = useRef<{ pointerId: number; startY: number; startScrollTop: number }>(undefined);

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="result-scrollbar"
      role="scrollbar"
      aria-label="Vertical result scroll"
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.round(geometry.maxScrollTop)}
      aria-valuenow={Math.round(scrollTop)}
      tabIndex={0}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const element = scroller.current;
        if (!element) return;
        const increments: Partial<Record<string, number>> = {
          ArrowDown: rowHeight,
          ArrowUp: -rowHeight,
          PageDown: metrics.clientHeight,
          PageUp: -metrics.clientHeight,
          Home: -geometry.maxScrollTop,
          End: geometry.maxScrollTop,
        };
        const increment = increments[event.key];
        if (increment === undefined) return;
        element.scrollTop = clamp(element.scrollTop + increment, 0, geometry.maxScrollTop);
        event.preventDefault();
      }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        const element = scroller.current;
        if (!element || geometry.maxScrollTop === 0) return;
        const track = event.currentTarget;
        const onThumb =
          event.target instanceof HTMLElement &&
          event.target.classList.contains("result-scroll-thumb");
        // Pressing the track jumps there, centred on the pointer; pressing the thumb takes hold.
        if (!onThumb) {
          const top = event.clientY - track.getBoundingClientRect().top - geometry.thumbHeight / 2;
          element.scrollTop =
            (clamp(top, 0, geometry.maxThumbTop) / geometry.maxThumbTop) * geometry.maxScrollTop;
        }
        drag.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startScrollTop: element.scrollTop,
        };
        track.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const held = drag.current;
        const element = scroller.current;
        if (!held || held.pointerId !== event.pointerId || !element || geometry.maxThumbTop === 0) {
          return;
        }
        const scrollPerPixel = geometry.maxScrollTop / geometry.maxThumbTop;
        element.scrollTop = clamp(
          held.startScrollTop + (event.clientY - held.startY) * scrollPerPixel,
          0,
          geometry.maxScrollTop,
        );
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      <div
        className="result-scroll-thumb"
        style={
          {
            "--result-scroll-thumb-height": `${geometry.thumbHeight}px`,
            "--result-scroll-thumb-top": `${geometry.thumbTop}px`,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

/** Where the thumb sits and how tall it is, from what the scrolled element measures. */
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
          Math.max(MIN_THUMB_HEIGHT, (clientHeight * clientHeight) / scrollHeight),
        );
  const maxThumbTop = Math.max(0, clientHeight - thumbHeight);
  const thumbTop =
    maxScrollTop === 0 ? 0 : (clamp(scrollTop, 0, maxScrollTop) / maxScrollTop) * maxThumbTop;
  return { thumbHeight, thumbTop, maxScrollTop, maxThumbTop };
}
