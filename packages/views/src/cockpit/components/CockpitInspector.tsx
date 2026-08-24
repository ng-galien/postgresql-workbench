import { useCallback, useEffect, useRef } from "react";
import { useCockpitStore } from "../graph/store.js";
import type { WorkbenchGraphSourcePreview } from "../protocol.js";
import { SourceInspector } from "./SourceInspector.js";
import { VisiblePathPicker } from "./VisiblePathPicker.js";

interface CockpitInspectorProps {
  preview: WorkbenchGraphSourcePreview;
  onClose(): void;
  placement: "side" | "bottom";
  width: number;
  height: number;
  onResizeWidth(width: number): void;
  onResizeHeight(height: number): void;
  pinned: boolean;
  onPinnedChange(pinned: boolean): void;
}

export function clampInspectorWidth(width: number, availableWidth: number): number {
  return Math.max(360, Math.min(560, availableWidth * 0.45, width));
}

export function clampInspectorHeight(height: number, availableHeight: number): number {
  return Math.max(240, Math.min(560, availableHeight * 0.55, height));
}

// CockpitInspector receives one named presentation contract; destructuring its fields does not
// create independent positional collaborators.
// code-moniker: ignore[code-single-responsibility-flags-long-parameter-lists]
export function CockpitInspector({
  preview,
  onClose,
  placement,
  width,
  height,
  onResizeWidth,
  onResizeHeight,
  pinned,
  onPinnedChange,
}: CockpitInspectorProps) {
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
    <aside
      className={`cockpit-inspector placement-${placement}`}
      data-inspector-placement={placement}
    >
      <InspectorResizeHandle
        placement={placement}
        width={width}
        height={height}
        onResizeWidth={onResizeWidth}
        onResizeHeight={onResizeHeight}
      />
      <SourceInspector
        preview={preview}
        onClose={onClose}
        pinned={pinned}
        onPinnedChange={onPinnedChange}
      />
      <div className="inspector-tools">
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
      </div>
    </aside>
  );
}

function InspectorResizeHandle({
  placement,
  width,
  height,
  onResizeWidth,
  onResizeHeight,
}: {
  placement: "side" | "bottom";
  width: number;
  height: number;
  onResizeWidth(width: number): void;
  onResizeHeight(height: number): void;
}) {
  const drag = useRef<{ coordinate: number; size: number } | null>(null);
  const resizeWidth = useCallback(
    (next: number) => {
      const availableWidth =
        document.querySelector<HTMLElement>(".cockpit-main")?.clientWidth ?? window.innerWidth;
      onResizeWidth(clampInspectorWidth(next, availableWidth));
    },
    [onResizeWidth],
  );
  const resizeHeight = useCallback(
    (next: number) => {
      const availableHeight =
        document.querySelector<HTMLElement>(".cockpit-main")?.clientHeight ?? window.innerHeight;
      onResizeHeight(clampInspectorHeight(next, availableHeight));
    },
    [onResizeHeight],
  );
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      if (placement === "side") {
        resizeWidth(drag.current.size + drag.current.coordinate - event.clientX);
      } else {
        resizeHeight(drag.current.size + drag.current.coordinate - event.clientY);
      }
    };
    const stop = () => {
      drag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [placement, resizeHeight, resizeWidth]);
  const size = placement === "side" ? width : height;
  const main = document.querySelector<HTMLElement>(".cockpit-main");
  const maximum =
    placement === "side"
      ? Math.round(
          clampInspectorWidth(Number.POSITIVE_INFINITY, main?.clientWidth ?? window.innerWidth),
        )
      : Math.round(
          clampInspectorHeight(Number.POSITIVE_INFINITY, main?.clientHeight ?? window.innerHeight),
        );
  return (
    <hr
      className="inspector-resize-handle"
      aria-label="Resize source inspector"
      aria-orientation={placement === "side" ? "vertical" : "horizontal"}
      aria-valuemin={placement === "side" ? 360 : 240}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(size)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        drag.current = {
          coordinate: placement === "side" ? event.clientX : event.clientY,
          size,
        };
      }}
      onKeyDown={(event) => {
        const decrease = placement === "side" ? "ArrowRight" : "ArrowDown";
        const increase = placement === "side" ? "ArrowLeft" : "ArrowUp";
        if (event.key === decrease || event.key === increase) event.preventDefault();
        if (event.key === increase) {
          if (placement === "side") resizeWidth(size + 20);
          else resizeHeight(size + 20);
        }
        if (event.key === decrease) {
          if (placement === "side") resizeWidth(size - 20);
          else resizeHeight(size - 20);
        }
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
