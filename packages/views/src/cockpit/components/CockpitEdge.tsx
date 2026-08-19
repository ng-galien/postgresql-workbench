import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  useStore,
} from "@xyflow/react";
import { relationClass, relationLabel } from "../graph/relationPresentation.js";
import { showCockpitEdgeLabel } from "../graph/zoom.js";

export interface CockpitEdgeData extends Record<string, unknown> {
  sourceLabel: string;
  targetLabel: string;
  kinds: string[];
  count: number;
  color: string;
  onSelect(): void;
}

export function CockpitEdge(props: EdgeProps) {
  const data = props.data as CockpitEdgeData;
  const showLabel = useStore((state) => showCockpitEdgeLabel(state.transform[2]));
  const [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 4, offset: 24 });
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{ ...props.style, stroke: data.color }}
        interactionWidth={18}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth="1"
        pointerEvents="none"
        data-graph-edge={props.id}
        data-source-identity={props.source}
        data-target-identity={props.target}
        data-source-label={data.sourceLabel}
        data-target-label={data.targetLabel}
        data-kinds={JSON.stringify(data.kinds)}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="cockpit-edge-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: data.color,
            }}
            onClick={data.onSelect}
          >
            <span className="cockpit-edge-kinds">
              {data.kinds.map((kind) => (
                <span key={kind} className={`cockpit-edge-kind ${relationClass(kind)}`}>
                  {relationLabel(kind)}
                </span>
              ))}
            </span>
            {data.count > 1 && <span className="cockpit-edge-count">×{data.count}</span>}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
