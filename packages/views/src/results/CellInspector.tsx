import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { type CellDetail, cellDetail } from "../../../rows/src/cellDetail.js";
import { countLabel } from "../../../rows/src/countLabel.js";

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
  onClose,
}: {
  /** The column the cursor is in, and what it was declared as. */
  column: string;
  typeName?: string;
  /** The cell under the cursor; absent when the cursor is on no cell at all. */
  cell?: DebugResultCell;
  onClose: () => void;
}) {
  const detail = cell ? cellDetail(cell, typeName) : undefined;
  /*
   * How large the reader wants it. The panel hangs from the far corner, so its grip is on the near
   * one and dragging towards the rows makes it bigger — the corner it is pinned to never moves.
   */
  const [size, setSize] = useState<{ width: number; height: number }>();
  const drag = useRef<{ x: number; y: number; width: number; height: number }>(undefined);
  return (
    <aside
      className="cell-inspector"
      aria-label={`Value of ${column}`}
      style={size ? { width: `${size.width}px`, maxHeight: `${size.height}px` } : undefined}
    >
      {/* The grip: dragging is a pointer gesture, and the panel's size is not a control's value. */}
      <div
        className="cell-inspector-grip"
        title="Drag to resize"
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          const panel = event.currentTarget.parentElement;
          if (!panel) return;
          const bounds = panel.getBoundingClientRect();
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            width: bounds.width,
            height: bounds.height,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          const from = drag.current;
          if (!from) return;
          setSize({
            width: Math.max(16 * 12, from.width - (event.clientX - from.x)),
            height: Math.max(16 * 6, from.height - (event.clientY - from.y)),
          });
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
      />
      <header className="cell-inspector-head">
        <span className="cell-inspector-column" title={column}>
          {column}
        </span>
        {typeName ? <span className="cell-inspector-type">{typeName}</span> : null}
        <span className="cell-inspector-spacer" />
        {detail && detail.shape !== "empty" ? (
          <button
            type="button"
            className="cell-inspector-action"
            title="Copy this value"
            aria-label="Copy this value"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (cell?.value !== null && cell?.value !== undefined) {
                void navigator.clipboard?.writeText(cell.value).catch(() => {});
              }
            }}
          >
            <span className="codicon codicon-copy" aria-hidden="true" />
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
      {cell?.truncated ? (
        <footer className="cell-inspector-foot">
          Cut short on its way here — the whole value is larger than a result may carry.
        </footer>
      ) : null}
    </aside>
  );
}

function shown(detail: CellDetail): ReactNode {
  switch (detail.shape) {
    case "empty":
      return (
        <p className="cell-inspector-null">NULL — no value at all, which is not an empty one.</p>
      );
    case "json":
      return (
        <>
          {detail.invalid ? (
            <p className="cell-inspector-invalid">Not valid JSON: {detail.invalid}</p>
          ) : null}
          <pre className="cell-inspector-json">{jsonTokens(detail.text)}</pre>
        </>
      );
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
    const shape = quoted ? (colon ? "key" : "string") : /^-?\d/u.test(whole) ? "number" : "word";
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
