import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { countLabel } from "../../../rows/src/countLabel.js";
import { useClipboardCopy } from "../clipboardCopy.js";
import { type CellDetail, cellDetail } from "./cellDetail.js";

/**
 * What the cell under the cursor holds, beside the grid rather than in it. A row of a table can
 * only ever show one line cut off where the column ends; this shows the value as the thing it is —
 * a document laid out, a list taken apart, bytes counted and named.
 *
 * It follows the cursor: moving with the arrow keys moves this too, so a reader reads a column by
 * walking down it rather than by opening one cell after another.
 */
export function CellInspector({
  column,
  typeName,
  cell,
  inspectorId,
  onClose,
  onResize,
}: {
  /** The column the cursor is in, and what it was declared as. */
  column: string;
  typeName?: string;
  /** The cell under the cursor; absent when the cursor is on no cell at all. */
  cell?: DebugResultCell;
  inspectorId?: string;
  onClose: () => void;
  /** Lets the grid reserve enough room when the panel grows beyond its usual viewport. */
  onResize?: (height: number) => void;
}) {
  const detail = cell ? cellDetail(cell, typeName) : undefined;
  /*
   * How large the reader wants it. The panel hangs from the far corner, so its grip is on the near
   * one and dragging towards the rows makes it bigger — the corner it is pinned to never moves.
   */
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const panelRef = useRef<HTMLElement>(null);
  const resize = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    position?: { left: number; top: number };
  }>(undefined);
  const move = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
  }>(undefined);
  const clipboard = useClipboardCopy();
  useEffect(() => {
    const panel = panelRef.current;
    const frame = panel?.parentElement;
    if (!panel || !frame || (!size && !position)) return undefined;
    const keepInsideFrame = () => {
      const frameBounds = frame.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      const maximumWidth = Math.max(1, frameBounds.width - (position ? 0 : 36));
      const width = Math.min(size?.width ?? panelBounds.width, maximumWidth);
      const height = size?.height ?? panelBounds.height;
      if (size && (width !== size.width || height !== size.height)) setSize({ width, height });
      if (position) {
        const next = {
          left: Math.min(Math.max(0, frameBounds.width - width), Math.max(0, position.left)),
          top: Math.min(Math.max(0, frameBounds.height - height), Math.max(0, position.top)),
        };
        if (next.left !== position.left || next.top !== position.top) setPosition(next);
      }
      onResize?.(height);
    };
    keepInsideFrame();
    const observer = new ResizeObserver(keepInsideFrame);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [onResize, position, size]);
  const resizeTo = (
    panel: HTMLElement,
    requestedWidth: number,
    requestedHeight: number,
    anchor?: { left: number; top: number; width: number; height: number },
  ) => {
    const frame = panel.parentElement;
    if (!frame) return;
    const frameBounds = frame.getBoundingClientRect();
    const minimumWidth = Math.min(16 * 12, frameBounds.width);
    const width = Math.min(
      Math.max(1, frameBounds.width - (position ? 0 : 36)),
      Math.max(minimumWidth, requestedWidth),
    );
    const height = Math.max(16 * 6, requestedHeight);
    setSize({ width, height });
    if (position || anchor) {
      const wanted = anchor
        ? {
            left: anchor.left + anchor.width - width,
            top: anchor.top + anchor.height - height,
          }
        : (position ?? { left: 0, top: 0 });
      const futureFrameHeight = Math.max(frameBounds.height, height + 24);
      setPosition({
        left: Math.min(Math.max(0, frameBounds.width - width), Math.max(0, wanted.left)),
        top: Math.min(Math.max(0, futureFrameHeight - height), Math.max(0, wanted.top)),
      });
    }
    onResize?.(height);
  };
  return (
    <aside
      ref={panelRef}
      id={inspectorId}
      className="cell-inspector"
      aria-label={`Value of ${column}`}
      style={
        size || position
          ? {
              ...(size
                ? {
                    width: `${size.width}px`,
                    height: `${size.height}px`,
                    maxHeight: `${size.height}px`,
                  }
                : {}),
              ...(position
                ? {
                    left: `${position.left}px`,
                    top: `${position.top}px`,
                    right: "auto",
                    bottom: "auto",
                  }
                : {}),
            }
          : undefined
      }
    >
      <button
        type="button"
        className="cell-inspector-grip"
        title="Drag to resize"
        aria-label="Resize the value panel (arrow keys)"
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          const panel = event.currentTarget.parentElement;
          if (!panel) return;
          const bounds = panel.getBoundingClientRect();
          resize.current = {
            x: event.clientX,
            y: event.clientY,
            width: bounds.width,
            height: bounds.height,
            ...(position ? { position } : {}),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
          const from = resize.current;
          if (!from) return;
          const panel = event.currentTarget.parentElement;
          if (!panel) return;
          resizeTo(
            panel,
            from.width - (event.clientX - from.x),
            from.height - (event.clientY - from.y),
            from.position
              ? { ...from.position, width: from.width, height: from.height }
              : undefined,
          );
        }}
        onPointerUp={() => {
          resize.current = undefined;
        }}
        onPointerCancel={() => {
          resize.current = undefined;
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const panel = event.currentTarget.parentElement;
          if (!panel) return;
          const bounds = panel.getBoundingClientRect();
          resizeTo(
            panel,
            bounds.width + (event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0),
            bounds.height + (event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0),
          );
        }}
      />
      <header className="cell-inspector-head">
        <span className="cell-inspector-column" title={column}>
          {column}
        </span>
        {typeName ? <span className="cell-inspector-type">{typeName}</span> : null}
        <span className="cell-inspector-spacer" />
        <button
          type="button"
          className="cell-inspector-move"
          title="Drag to move"
          aria-label="Move the value panel"
          onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
            const panel = event.currentTarget.closest<HTMLElement>(".cell-inspector");
            const frame = panel?.parentElement;
            if (!panel || !frame) return;
            const bounds = panel.getBoundingClientRect();
            const frameBounds = frame.getBoundingClientRect();
            move.current = {
              x: event.clientX,
              y: event.clientY,
              left: bounds.left - frameBounds.left,
              top: bounds.top - frameBounds.top,
              maxLeft: Math.max(0, frameBounds.width - bounds.width),
              maxTop: Math.max(0, frameBounds.height - bounds.height),
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
            const from = move.current;
            if (!from) return;
            setPosition({
              left: Math.min(from.maxLeft, Math.max(0, from.left + event.clientX - from.x)),
              top: Math.min(from.maxTop, Math.max(0, from.top + event.clientY - from.y)),
            });
          }}
          onPointerUp={() => {
            move.current = undefined;
          }}
          onPointerCancel={() => {
            move.current = undefined;
          }}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const panel = event.currentTarget.closest<HTMLElement>(".cell-inspector");
            const frame = panel?.parentElement;
            if (!panel || !frame) return;
            const bounds = panel.getBoundingClientRect();
            const frameBounds = frame.getBoundingClientRect();
            const left = bounds.left - frameBounds.left;
            const top = bounds.top - frameBounds.top;
            setPosition({
              left: Math.min(
                Math.max(0, frameBounds.width - bounds.width),
                Math.max(
                  0,
                  left + (event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0),
                ),
              ),
              top: Math.min(
                Math.max(0, frameBounds.height - bounds.height),
                Math.max(
                  0,
                  top + (event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0),
                ),
              ),
            });
          }}
        >
          <span className="codicon codicon-grabber" aria-hidden="true" />
        </button>
        {detail && detail.shape !== "empty" ? (
          <button
            type="button"
            className="cell-inspector-action"
            title={COPY_LABEL[clipboard.state]}
            aria-label={COPY_LABEL[clipboard.state]}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (cell?.value !== null && cell?.value !== undefined) clipboard.copy(cell.value);
            }}
          >
            <span className={`codicon codicon-${COPY_ICON[clipboard.state]}`} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="cell-inspector-action"
          title="Close the value panel"
          aria-label="Close the value panel"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      <div className="cell-inspector-body">{detail ? shown(detail) : null}</div>
      {cell?.retainedTruncated ? (
        <footer className="cell-inspector-foot">
          Truncated at the configured result-cell limit. Change PostgreSQL Workbench › Results: Max
          Cell Bytes in Settings.
        </footer>
      ) : cell?.truncated ? (
        <footer className="cell-inspector-foot">
          Shortened for display. The retained value remains available to the result host.
        </footer>
      ) : null}
    </aside>
  );
}

/* What the copy control shows, and says, once it has an answer to give. */
const COPY_ICON = { idle: "copy", copied: "check", error: "error" } as const;
const COPY_LABEL = {
  idle: "Copy this value",
  copied: "Value copied",
  error: "The value could not be copied",
} as const;

function shown(detail: CellDetail): ReactNode {
  switch (detail.shape) {
    case "empty":
      return (
        <p className="cell-inspector-null">NULL — no value at all, which is not an empty one.</p>
      );
    case "json":
      return <pre className="cell-inspector-json">{jsonTokens(detail.text)}</pre>;
    case "list":
      return detail.items.length === 0 ? (
        <p className="cell-inspector-null">An empty list — which is not the same as NULL.</p>
      ) : (
        <>
          <p className="cell-inspector-count">{countLabel(detail.items.length, "item")}</p>
          <ol className="cell-inspector-list">
            {detail.items.map((item, index) => (
              // The position is the identity here: two items may read the same and both belong.
              // biome-ignore lint/suspicious/noArrayIndexKey: a list's order is what it is.
              <li key={index}>{item}</li>
            ))}
          </ol>
        </>
      );
    case "binary":
      return (
        <>
          <p className="cell-inspector-count">
            {countLabel(detail.bytes, "byte")}
            {detail.truncated ? " or more" : ""}
            {detail.looksLike ? ` · ${detail.looksLike}` : ""}
          </p>
          {detail.image ? (
            <img
              className="cell-inspector-image"
              src={`data:${detail.image.mediaType};base64,${base64OfHex(detail.image.hex)}`}
              alt={`The ${detail.looksLike ?? "picture"} this cell holds`}
            />
          ) : (
            <pre className="cell-inspector-hex">{detail.head}</pre>
          )}
        </>
      );
    case "link":
      return (
        <a className="cell-inspector-link" href={detail.href} target="_blank" rel="noreferrer">
          {detail.href}
        </a>
      );
    default:
      return <pre className="cell-inspector-text">{detail.text}</pre>;
  }
}

/* The bytes as a browser wants them: a data URL carries base64, and PostgreSQL gave us hex. */
function base64OfHex(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/*
 * The document, coloured. The text was laid out by JSON.stringify a moment ago, so what is matched
 * here is this module's own output and not something a database wrote: a key is a string followed
 * by a colon, and everything else is what it looks like.
 */
const JSON_TOKENS =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/gu;

function jsonTokens(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let key = 0;
  for (const match of text.matchAll(JSON_TOKENS)) {
    const start = match.index;
    if (start > at) out.push(text.slice(at, start));
    const [whole, quoted, colon] = match;
    const shape = quoted
      ? colon
        ? "key"
        : "string"
      : /^-?\d/u.test(whole)
        ? "number"
        : whole === "null"
          ? "null"
          : "boolean";
    out.push(
      <span className={`json-${shape}`} key={`t${key}`}>
        {quoted ?? whole}
      </span>,
    );
    key += 1;
    if (colon) out.push(colon);
    at = start + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
