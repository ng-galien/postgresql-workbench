import { countLabel } from "../../../../rows/src/countLabel.js";
import { relationLabel } from "../graph/relationPresentation.js";
import { useCockpitStore } from "../graph/store.js";
import { inspectSymbol } from "../graph/transport.js";
import type { CockpitMessaging } from "../protocol.js";

export function CockpitEdgePopover({ messaging }: { messaging: CockpitMessaging }) {
  const selected = useCockpitStore((state) => state.selectedEdgeId);
  const edge = useCockpitStore((state) =>
    state.selectedEdgeId ? state.exploration.edges[state.selectedEdgeId] : undefined,
  );
  const nodes = useCockpitStore((state) => state.exploration.nodes);
  const select = useCockpitStore((state) => state.selectEdge);
  if (!selected || !edge) return null;
  return (
    <aside className="edge-popover" aria-label="Selected dependency">
      <header>
        <strong>{nodes[edge.source]?.presentation.label ?? edge.source}</strong>
        <span>→</span>
        <strong>{nodes[edge.target]?.presentation.label ?? edge.target}</strong>
        <button type="button" aria-label="Close dependency details" onClick={() => select(null)}>
          ×
        </button>
      </header>
      <div className="edge-summary">
        <span>{edge.kinds.map(relationLabel).join(" · ")}</span>
        <span>{countLabel(edge.count, "reference")}</span>
      </div>
      <button type="button" onClick={() => inspectSymbol(messaging, edge.source)}>
        Show caller DDL
      </button>
    </aside>
  );
}
