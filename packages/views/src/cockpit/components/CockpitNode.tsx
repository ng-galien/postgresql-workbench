import { Handle, Position, useStore } from "@xyflow/react";
import { postgresVisual } from "../../../../presentation/src/presentation.js";
import type { CockpitNodeModel } from "../graph/domain.js";
import { useCockpitStore } from "../graph/store.js";
import { cockpitZoomLevel } from "../graph/zoom.js";
import type { CockpitDirection } from "../protocol.js";

export interface CockpitNodeData extends Record<string, unknown> {
  node: CockpitNodeModel;
  role: "focus" | "neighbor" | "pinned";
  sourceActive: boolean;
  hidden: { incoming: number; outgoing: number };
  onFocus(identity: string): void;
  onToggleSource(identity: string): void;
  onOpen(identity: string): void;
  onActions(identity: string): void;
  onPin(identity: string): void;
  onExpand(identity: string, direction: CockpitDirection): void;
}

export function CockpitNode({
  data,
  dragging = false,
}: {
  data: CockpitNodeData;
  dragging?: boolean;
}) {
  const { node, role } = data;
  const compactZoomThreshold = useCockpitStore((state) => state.appearance.compactZoomThreshold);
  const zoomLevel = useStore((state) => cockpitZoomLevel(state.transform[2], compactZoomThreshold));
  return (
    <article
      className={`cockpit-node kind-${node.symbol.kind} role-${role} zoom-${zoomLevel}${dragging ? " is-dragging" : ""}`}
      data-graph-card={node.identity}
      data-graph-label={node.presentation.label}
      data-graph-kind={node.presentation.kind}
      data-graph-role={role}
      aria-label={`${node.presentation.label}, PostgreSQL ${node.presentation.kind}`}
    >
      <Handle type="target" position={Position.Left} className="cockpit-port" />
      <span className="node-drag-handle" aria-hidden="true" title="Drag to reposition">
        ⠿
      </span>
      <button
        type="button"
        className="node-main"
        title={`${node.presentation.label} — focus this object`}
        onClick={(event) => {
          event.stopPropagation();
          data.onFocus(node.identity);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          data.onOpen(node.identity);
        }}
      >
        <span className="node-title">
          <span className="node-glyph">{postgresVisual(node.symbol.kind).glyph}</span>
          <strong title={zoomLevel === "compact" ? node.presentation.label : undefined}>
            {node.presentation.label}
          </strong>
          {role === "focus" && <span className="focus-flag">focus</span>}
          {node.pinned && <span className="pin-flag">⚑</span>}
        </span>
        <span className="node-degrees">
          <span>▲ {node.incoming}</span>
          <span>▼ {node.outgoing}</span>
        </span>
      </button>
      <div
        className="node-actions"
        role="toolbar"
        aria-label={`Actions for ${node.presentation.label}`}
      >
        <button
          type="button"
          className={`nodrag node-source-toggle${data.sourceActive ? " is-active" : ""}`}
          title={data.sourceActive ? "Hide DDL preview" : "Preview DDL in the Cockpit"}
          aria-pressed={data.sourceActive}
          onClick={() => data.onToggleSource(node.identity)}
        >
          DDL
        </button>
        <button
          type="button"
          className="nodrag"
          title="Open the indexed definition in the editor"
          onClick={() => data.onOpen(node.identity)}
        >
          Open ↗
        </button>
        {role !== "focus" && (
          <button
            type="button"
            className="nodrag"
            title={
              node.pinned ? "Stop keeping this object visible" : "Keep visible while navigating"
            }
            onClick={() => data.onPin(node.identity)}
          >
            {node.pinned ? "Unpin" : "Pin"}
          </button>
        )}
        {node.presentation.hasCockpitActions && (
          <button
            type="button"
            className="nodrag"
            aria-label="More routine actions"
            title="More routine actions"
            onClick={() => data.onActions(node.identity)}
          >
            ···
          </button>
        )}
      </div>
      {(data.hidden.incoming > 0 || data.hidden.outgoing > 0) && (
        <div className="node-expansions">
          {data.hidden.incoming > 0 && (
            <ExpandButton
              direction="incoming"
              count={data.hidden.incoming}
              onClick={() => data.onExpand(node.identity, "incoming")}
            />
          )}
          {data.hidden.outgoing > 0 && (
            <ExpandButton
              direction="outgoing"
              count={data.hidden.outgoing}
              onClick={() => data.onExpand(node.identity, "outgoing")}
            />
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="cockpit-port" />
    </article>
  );
}

function ExpandButton({
  direction,
  count,
  onClick,
}: {
  direction: CockpitDirection;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`nodrag expand-${direction}`}
      title={`${count} hidden ${direction === "incoming" ? "upstream objects" : "downstream objects"}; add the next ${Math.min(3, count)}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {direction === "incoming" ? `← +${Math.min(3, count)}` : `+${Math.min(3, count)} →`}
    </button>
  );
}
