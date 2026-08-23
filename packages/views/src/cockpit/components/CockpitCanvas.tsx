import {
  Background,
  BackgroundVariant,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasWorkbenchTreeDrag,
  parseWorkbenchGraphDrag,
  WORKBENCH_GRAPH_OBJECT_MIME,
  WORKBENCH_GRAPH_UNSUPPORTED_MIME,
  type WorkbenchGraphDragPayload,
} from "../dragAndDrop.js";

export { hasWorkbenchTreeDrag };

import { reconcileControlledNodes } from "../graph/controlledNodes.js";
import { hiddenCount } from "../graph/domain.js";
import { layoutCockpit } from "../graph/layout.js";
import { relationColor } from "../graph/relationPresentation.js";
import { useCockpitStore } from "../graph/store.js";
import {
  debugSymbol,
  dismissSource,
  focusSymbol,
  inspectSymbol,
  openSymbol,
  requestNeighborhood,
  setPinnedSymbol,
} from "../graph/transport.js";
import { post } from "../vscodeApi.js";
import { CockpitEdge, type CockpitEdgeData } from "./CockpitEdge.js";
import { CockpitNode, type CockpitNodeData } from "./CockpitNode.js";

const NODE_TYPES = { cockpit: CockpitNode };
const EDGE_TYPES = { cockpit: CockpitEdge };

export function CockpitCanvas({ frameRequest }: { frameRequest: string }) {
  const exploration = useCockpitStore((state) => state.exploration);
  const filters = useCockpitStore((state) => state.relationFilters);
  const positions = useCockpitStore((state) => state.positions);
  const setPosition = useCockpitStore((state) => state.setPosition);
  const reveal = useCockpitStore((state) => state.reveal);
  const pin = useCockpitStore((state) => state.pin);
  const selectedEdgeId = useCockpitStore((state) => state.selectedEdgeId);
  const selectEdge = useCockpitStore((state) => state.selectEdge);
  const hoveredIdentity = useCockpitStore((state) => state.hoveredIdentity);
  const hover = useCockpitStore((state) => state.hover);
  const pathIdentities = useCockpitStore((state) => state.pathIdentities);
  const treeDragPayload = useCockpitStore((state) => state.treeDragPayload);
  const clearTreeDrag = useCockpitStore((state) => state.clearTreeDrag);
  const sourceVisible = useCockpitStore((state) => state.sourceVisible);
  const preview = useCockpitStore((state) => state.preview);
  const dismissPreview = useCockpitStore((state) => state.dismissPreview);
  const flow = useRef<ReactFlowInstance<Node<CockpitNodeData>, Edge<CockpitEdgeData>> | null>(null);
  const [dropFeedback, setDropFeedback] = useState<WorkbenchGraphDragPayload | null>(null);
  const treeDragRequested = useRef(false);
  const canvasElement = useRef<HTMLElement | null>(null);
  const [flowReady, setFlowReady] = useState(0);
  const positionCache = useRef<Record<string, { x: number; y: number }>>({});
  const layoutFocus = useRef<string | null>(null);
  const controlledLayout = useRef({
    focusIdentity: exploration.focusIdentity,
    positions,
  });
  const frameIdentities = useRef(new Set<string>());
  const nodes = useMemo(() => Object.values(exploration.nodes), [exploration.nodes]);
  const pathSet = useMemo(() => new Set(pathIdentities), [pathIdentities]);
  const allEdges = useMemo(() => Object.values(exploration.edges), [exploration.edges]);
  const visibleEdges = useMemo(
    () => allEdges.filter((edge) => edge.kinds.some((kind) => filters[kind] !== false)),
    [allEdges, filters],
  );
  if (layoutFocus.current !== exploration.focusIdentity) {
    layoutFocus.current = exploration.focusIdentity;
    positionCache.current = { ...positions };
  }
  frameIdentities.current = new Set(
    [
      exploration.focusIdentity,
      ...nodes.filter((node) => node.pinned).map((node) => node.identity),
      ...Object.values(exploration.edges).flatMap((edge) => {
        if (
          edge.source === exploration.focusIdentity ||
          edge.target === exploration.focusIdentity
        ) {
          return [edge.source, edge.target];
        }
        return [];
      }),
    ].filter((identity): identity is string => Boolean(identity)),
  );
  const laidOut = useMemo(() => {
    const next = layoutCockpit(nodes, allEdges, exploration.focusIdentity, {
      ...positionCache.current,
      ...positions,
    });
    positionCache.current = next;
    return next;
  }, [allEdges, exploration.focusIdentity, nodes, positions]);

  const onExpand = useCallback<CockpitNodeData["onExpand"]>(
    (identity, direction) => {
      if (exploration.neighborhoods[identity]) reveal(identity, direction);
      else requestNeighborhood(identity, "expand", direction);
    },
    [exploration.neighborhoods, reveal],
  );
  const onPin = useCallback<CockpitNodeData["onPin"]>(
    (identity) => {
      const willPin = !exploration.nodes[identity]?.pinned;
      pin(identity);
      setPinnedSymbol(identity, willPin);
    },
    [exploration.nodes, pin],
  );
  const onToggleSource = useCallback<CockpitNodeData["onToggleSource"]>(
    (identity) => {
      if (sourceVisible && preview?.symbolUri === identity) {
        dismissPreview();
        dismissSource();
      } else {
        inspectSymbol(identity);
      }
    },
    [dismissPreview, preview?.symbolUri, sourceVisible],
  );
  const flowNodes = useMemo(() => {
    const base: Array<Node<CockpitNodeData>> = nodes.map((node) => {
      const role =
        node.identity === exploration.focusIdentity ? "focus" : node.pinned ? "pinned" : "neighbor";
      return {
        id: node.identity,
        type: "cockpit",
        dragHandle: ".node-drag-handle",
        ariaLabel: `${node.presentation.label}, PostgreSQL ${node.presentation.kind}. Select and use the arrow keys to reposition.`,
        position: laidOut[node.identity] ?? { x: 0, y: 0 },
        data: {
          node,
          role,
          sourceActive: sourceVisible && preview?.symbolUri === node.identity,
          hidden: {
            incoming: hiddenCount(exploration, node.identity, "incoming"),
            outgoing: hiddenCount(exploration, node.identity, "outgoing"),
          },
          onFocus: focusSymbol,
          onToggleSource,
          onOpen: openSymbol,
          onActions: debugSymbol,
          onPin,
          onExpand,
        },
        className: [
          node.identity === hoveredIdentity ? "is-highlighted" : "",
          pathSet.has(node.identity) ? "is-on-path" : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    });
    return base;
  }, [
    exploration,
    hoveredIdentity,
    laidOut,
    nodes,
    onExpand,
    onPin,
    onToggleSource,
    pathSet,
    preview?.symbolUri,
    sourceVisible,
  ]);
  const [controlledNodes, setControlledNodes, onNodesChange] =
    useNodesState<Node<CockpitNodeData>>(flowNodes);
  useEffect(() => {
    const resetLayout =
      controlledLayout.current.focusIdentity !== exploration.focusIdentity ||
      controlledLayout.current.positions !== positions;
    controlledLayout.current = { focusIdentity: exploration.focusIdentity, positions };
    setControlledNodes((current) => reconcileControlledNodes(current, flowNodes, resetLayout));
  }, [exploration.focusIdentity, flowNodes, positions, setControlledNodes]);
  const flowEdges = useMemo<Array<Edge<CockpitEdgeData>>>(
    () =>
      visibleEdges.map((edge) => {
        const kind = edge.kinds[0] ?? "references";
        const onPath = pathSet.has(edge.source) && pathSet.has(edge.target);
        const color = onPath ? "var(--vscode-charts-yellow)" : relationColor(kind);
        const data: CockpitEdgeData = {
          sourceLabel: exploration.nodes[edge.source]?.presentation.label ?? edge.source,
          targetLabel: exploration.nodes[edge.target]?.presentation.label ?? edge.target,
          kinds: edge.kinds,
          count: edge.count,
          color,
          onSelect: () => selectEdge(edge.id),
        };
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "cockpit",
          data,
          selected: selectedEdgeId === edge.id,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          style: { strokeWidth: Math.min(1.5 + Math.log2(edge.count + 1) * 0.45, 4) },
          className: onPath ? "is-on-path" : undefined,
        };
      }),
    [exploration.nodes, pathSet, selectEdge, selectedEdgeId, visibleEdges],
  );

  const frameNeighborhood = useCallback(
    (instance: ReactFlowInstance<Node<CockpitNodeData>, Edge<CockpitEdgeData>>) => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const framed = instance.getNodes().filter((node) => frameIdentities.current.has(node.id));
          if (framed.length === 0) return;
          void instance.fitView({
            nodes: framed,
            padding: 0.18,
            minZoom: 0.55,
            maxZoom: 1,
            duration: reducedMotion ? 0 : 180,
          });
        });
      });
    },
    [],
  );

  useEffect(() => {
    if (flowReady < 1 || frameRequest.length === 0 || !flow.current) return;
    frameNeighborhood(flow.current);
  }, [flowReady, frameNeighborhood, frameRequest]);

  const activeDropFeedback = dropFeedback ?? treeDragPayload;

  return (
    <section
      ref={canvasElement}
      aria-label="PostgreSQL graph canvas"
      className={[
        "cockpit-canvas",
        activeDropFeedback?.availability === "accepted" ? "is-drop-accepted" : "",
        activeDropFeedback?.availability === "unsupported" ? "is-drop-rejected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-cockpit-focus={exploration.focusIdentity ?? undefined}
      onDragOver={(event) => {
        const nativeTreeDrag = hasWorkbenchTreeDrag(event.dataTransfer);
        const payload = graphDragPayload(event.dataTransfer, !nativeTreeDrag);
        if (!payload && !nativeTreeDrag) return;
        event.preventDefault();
        if (payload) setDropFeedback(payload);
        if (nativeTreeDrag && !treeDragRequested.current) {
          treeDragRequested.current = true;
          post({ type: "resolveTreeDrag" });
        }
        const resolved = payload ?? treeDragPayload;
        event.dataTransfer.dropEffect = resolved?.availability === "unsupported" ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) return;
        setDropFeedback(null);
        clearTreeDrag();
        treeDragRequested.current = false;
        post({ type: "clearTreeDrag" });
      }}
      onDrop={(event) => {
        event.preventDefault();
        const directPayload = graphDragPayload(event.dataTransfer);
        const nativeTreeDrag = hasWorkbenchTreeDrag(event.dataTransfer);
        const payload = directPayload ?? treeDragPayload;
        setDropFeedback(null);
        clearTreeDrag();
        treeDragRequested.current = false;
        if (payload?.availability !== "accepted") {
          post({ type: "clearTreeDrag" });
          return;
        }
        if (nativeTreeDrag && !directPayload) {
          post({ type: "dropTreeSource" });
        } else {
          post({ type: "dropSource", payload });
        }
      }}
    >
      <ReactFlow
        nodes={controlledNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        minZoom={0.25}
        maxZoom={1.8}
        nodesConnectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
        onInit={(instance) => {
          flow.current = instance;
          setFlowReady((value) => value + 1);
        }}
        onNodeDragStop={(_, node) => {
          positionCache.current[node.id] = node.position;
          setPosition(node.id, node.position);
        }}
        onNodeMouseEnter={(_, node) => {
          hover(node.id);
        }}
        onNodeMouseLeave={() => {
          hover(null);
        }}
        onEdgeClick={(_, edge) => selectEdge(edge.id)}
        onPaneClick={() => {
          selectEdge(null);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
      {!exploration.focusIdentity && <CockpitEmpty />}
      {activeDropFeedback && (
        <div
          className="cockpit-drop-feedback"
          role="status"
          aria-live="polite"
          data-drop-availability={activeDropFeedback.availability}
        >
          <strong>
            {activeDropFeedback.availability === "accepted"
              ? `Open ${activeDropFeedback.label}`
              : "Cannot add this item"}
          </strong>
          <span>
            {activeDropFeedback.availability === "accepted"
              ? "Drop to focus this object in the graph."
              : activeDropFeedback.reason}
          </span>
        </div>
      )}
    </section>
  );
}

export function graphDragPayload(
  dataTransfer: DataTransfer,
  allowTypeFallback = false,
): WorkbenchGraphDragPayload | undefined {
  for (const mime of [WORKBENCH_GRAPH_OBJECT_MIME, WORKBENCH_GRAPH_UNSUPPORTED_MIME]) {
    const value = dataTransfer.getData(mime);
    const payload = parseWorkbenchGraphDrag(value);
    if (payload) return payload;
  }
  const plain = parseWorkbenchGraphDrag(dataTransfer.getData("text/plain"));
  if (plain) return plain;
  if (allowTypeFallback) {
    const types = new Set([...dataTransfer.types].map((type) => type.toLocaleLowerCase()));
    if (types.has(WORKBENCH_GRAPH_UNSUPPORTED_MIME)) {
      return {
        version: 1,
        availability: "unsupported",
        label: "Sources item",
        reason: "This item is not a graph-projectable PostgreSQL object.",
      };
    }
    if (types.has(WORKBENCH_GRAPH_OBJECT_MIME)) {
      return {
        version: 1,
        availability: "accepted",
        serverId: "",
        database: "",
        sourceUri: "",
        symbolUri: "",
        kind: "table",
        label: "PostgreSQL object",
      };
    }
  }
  return undefined;
}

function CockpitEmpty() {
  const session = useCockpitStore((state) => state.session);
  return (
    <section className="cockpit-empty">
      <div>
        <span className="empty-kicker">{session?.database ?? "PostgreSQL"} cockpit</span>
        <h1>Explore the database.</h1>
        <p>
          Use the search above, select an item in Sources, or drag a table, view, routine, or
          trigger here. Search a schema directly, then combine filters such as{" "}
          <code>schema:name</code> and <code>type:table</code>.
        </p>
      </div>
    </section>
  );
}
