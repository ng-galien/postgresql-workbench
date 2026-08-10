import { useRef } from "react";
import type { WorkbenchGraphSourcePreview } from "../../protocol.js";
import { SourceInspector } from "../SourceInspector.js";
import { useCockpitStore } from "./store.js";
import { VisiblePathPicker } from "./VisiblePathPicker.js";

interface CockpitInspectorProps {
  preview: WorkbenchGraphSourcePreview;
  onClose(): void;
  width: number;
  onResize(width: number): void;
}

export function CockpitInspector({ preview, onClose, width, onResize }: CockpitInspectorProps) {
  const exploration = useCockpitStore((state) => state.exploration);
  const reveal = useCockpitStore((state) => state.reveal);
  const focusIdentity = exploration.focusIdentity;
  const catalog = focusIdentity ? exploration.neighborhoods[focusIdentity] : undefined;
  const hiddenIncoming = catalog
    ? catalog.value.incoming.slice(catalog.revealed.incoming, catalog.revealed.incoming + 3)
    : [];
  const hiddenOutgoing = catalog
    ? catalog.value.outgoing.slice(catalog.revealed.outgoing, catalog.revealed.outgoing + 3)
    : [];
  return (
    <aside className="cockpit-inspector">
      <InspectorResizeHandle width={width} onResize={onResize} />
      <SourceInspector preview={preview} onClose={onClose} />
      {(hiddenIncoming.length > 0 || hiddenOutgoing.length > 0) && (
        <section className="hidden-neighbors" aria-label="Hidden neighbors">
          <header>
            <strong>Hidden neighbors</strong>
            <span className="hidden-neighbor-hint">ranked by degree of interest</span>
          </header>
          {hiddenIncoming.length > 0 && (
            <NeighborPreview
              label="upstream"
              names={hiddenIncoming.map((neighbor) => neighbor.symbol.name)}
              count={Math.max(
                0,
                (catalog?.value.totals.incoming ?? 0) - (catalog?.revealed.incoming ?? 0),
              )}
              onReveal={() => focusIdentity && reveal(focusIdentity, "incoming")}
            />
          )}
          {hiddenOutgoing.length > 0 && (
            <NeighborPreview
              label="dependencies"
              names={hiddenOutgoing.map((neighbor) => neighbor.symbol.name)}
              count={Math.max(
                0,
                (catalog?.value.totals.outgoing ?? 0) - (catalog?.revealed.outgoing ?? 0),
              )}
              onReveal={() => focusIdentity && reveal(focusIdentity, "outgoing")}
            />
          )}
        </section>
      )}
      <VisiblePathPicker />
    </aside>
  );
}

function InspectorResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize(width: number): void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) =>
    onResize(Math.max(280, Math.min(window.innerWidth * 0.55, next)));
  return (
    <hr
      className="inspector-resize-handle"
      aria-label="Resize source inspector"
      aria-orientation="vertical"
      aria-valuemin={280}
      aria-valuemax={Math.round(window.innerWidth * 0.55)}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.preventDefault();
        if (event.key === "ArrowLeft") resize(width + 20);
        if (event.key === "ArrowRight") resize(width - 20);
      }}
    />
  );
}

function NeighborPreview({
  label,
  names,
  count,
  onReveal,
}: {
  label: string;
  names: string[];
  count: number;
  onReveal(): void;
}) {
  return (
    <div className="neighbor-preview">
      <span className="neighbor-names">
        <strong>{label}</strong> {names.join(", ")}
      </span>
      <button type="button" onClick={onReveal} title={`Reveal the next ${Math.min(3, count)}`}>
        +{Math.min(3, count)}
      </button>
    </div>
  );
}
