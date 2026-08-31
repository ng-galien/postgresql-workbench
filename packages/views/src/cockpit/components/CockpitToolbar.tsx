import { Fragment } from "react";
import { relationClass, relationLabel } from "../graph/relationPresentation.js";
import { useCockpitStore } from "../graph/store.js";
import { focusSymbol } from "../graph/transport.js";
import type { CockpitDirection, CockpitMessaging } from "../protocol.js";
import { CockpitSearch } from "./CockpitSearch.js";

const RELATIONS = ["calls", "reads", "writes", "references", "uses_type"];

export function CockpitToolbar({
  messaging,
  onRecenter,
}: {
  messaging: CockpitMessaging;
  onRecenter: () => void;
}) {
  const session = useCockpitStore((state) => state.session);
  const relationFilters = useCockpitStore((state) => state.relationFilters);
  const toggleRelation = useCockpitStore((state) => state.toggleRelation);
  const radius = useCockpitStore((state) => state.radius);
  const setRadius = useCockpitStore((state) => state.setRadius);
  const undo = useCockpitStore((state) => state.undoExpansion);
  const redo = useCockpitStore((state) => state.redoExpansion);
  const canUndo = useCockpitStore((state) => state.expansionUndo.length > 0);
  const canRedo = useCockpitStore((state) => state.expansionRedo.length > 0);
  const exploration = useCockpitStore((state) => state.exploration);
  const hidden = Object.values(exploration.neighborhoods).reduce(
    (total, neighborhood) =>
      total +
      Math.max(0, neighborhood.value.totals.incoming - neighborhood.revealed.incoming) +
      Math.max(0, neighborhood.value.totals.outgoing - neighborhood.revealed.outgoing),
    0,
  );
  return (
    <header className="cockpit-toolbar">
      <div className="toolbar-primary">
        <div className="history-controls">
          <button
            type="button"
            title="Back (Alt+Left)"
            disabled={!session?.canBack}
            onClick={() => messaging.post({ type: "back" })}
          >
            ←
          </button>
          <button
            type="button"
            title="Forward (Alt+Right)"
            disabled={!session?.canForward}
            onClick={() => messaging.post({ type: "forward" })}
          >
            →
          </button>
        </div>
        <nav className="cockpit-breadcrumbs" aria-label="Cockpit location">
          {session?.breadcrumbs.map((step, index) => (
            <Fragment key={step.prefix}>
              {index > 0 && <span>›</span>}
              <button type="button" onClick={() => focusSymbol(messaging, step.prefix)}>
                {step.label}
              </button>
            </Fragment>
          ))}
        </nav>
        <CockpitSearch messaging={messaging} />
        <RadiusControl direction="incoming" value={radius.incoming} setValue={setRadius} />
        <RadiusControl direction="outgoing" value={radius.outgoing} setValue={setRadius} />
        <span className="cockpit-counts">
          {Object.keys(exploration.nodes).length} objects · {Object.keys(exploration.edges).length}{" "}
          links
          {hidden > 0 ? ` · ▲ ${hidden} hidden` : ""}
        </span>
      </div>
      <div className="toolbar-secondary">
        <span className="toolbar-label">Relations</span>
        {RELATIONS.map((relation) => (
          <button
            type="button"
            className={`relation-toggle ${relationClass(relation)} ${relationFilters[relation] === false ? "" : "active"}`}
            aria-pressed={relationFilters[relation] !== false}
            key={relation}
            onClick={() => toggleRelation(relation)}
          >
            {relationLabel(relation)}
          </button>
        ))}
        <span className="toolbar-spacer" />
        <button type="button" disabled={!canUndo} onClick={undo} title="Undo expansion">
          ↶ Expand
        </button>
        <button type="button" disabled={!canRedo} onClick={redo} title="Redo expansion">
          ↷
        </button>
        <button type="button" onClick={onRecenter} title="Recenter on focus">
          ◎ Recenter
        </button>
      </div>
    </header>
  );
}

function RadiusControl({
  direction,
  value,
  setValue,
}: {
  direction: CockpitDirection;
  value: number;
  setValue: (direction: CockpitDirection, value: number) => void;
}) {
  return (
    <fieldset className="radius-control">
      <legend className="sr-only">{direction} radius</legend>
      <span>{direction === "incoming" ? "upstream" : "downstream"}</span>
      <button type="button" onClick={() => setValue(direction, value - 1)} disabled={value === 0}>
        −
      </button>
      <strong>{value}</strong>
      <button type="button" onClick={() => setValue(direction, value + 1)} disabled={value === 4}>
        +
      </button>
    </fieldset>
  );
}
