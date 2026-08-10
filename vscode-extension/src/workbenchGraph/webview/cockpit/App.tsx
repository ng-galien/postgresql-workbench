import { type CSSProperties, useEffect, useRef, useState } from "react";
import { vscode } from "../vscodeApi.js";
import { CockpitCanvas } from "./CockpitCanvas.js";
import { CockpitEdgePopover } from "./CockpitEdgePopover.js";
import { CockpitInspector } from "./CockpitInspector.js";
import { CockpitToolbar } from "./CockpitToolbar.js";
import { readCockpitEvidence } from "./evidence.js";
import { PerspectiveBar } from "./PerspectiveBar.js";
import { useCockpitStore } from "./store.js";
import { requestNeighborhood } from "./transport.js";

export function App() {
  const receive = useCockpitStore((state) => state.receive);
  const session = useCockpitStore((state) => state.session);
  const exploration = useCockpitStore((state) => state.exploration);
  const preview = useCockpitStore((state) => state.preview);
  const error = useCockpitStore((state) => state.error);
  const radius = useCockpitStore((state) => state.radius);
  const restoredExpansions = useCockpitStore((state) => state.restoredExpansions);
  const reveal = useCockpitStore((state) => state.reveal);
  const undo = useCockpitStore((state) => state.undoExpansion);
  const redo = useCockpitStore((state) => state.redoExpansion);
  const dismissPreview = useCockpitStore((state) => state.dismissPreview);
  const [recenterToken, setRecenterToken] = useState(0);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const radiusRequests = useRef<{ renderId: number | null; keys: Set<string> }>({
    renderId: null,
    keys: new Set(),
  });
  const renderId = session?.renderId ?? null;
  if (radiusRequests.current.renderId !== renderId) {
    radiusRequests.current = { renderId, keys: new Set() };
  }
  const evidenceKey = `${session?.renderId ?? 0}:${Object.keys(exploration.nodes).length}:${Object.keys(exploration.edges).length}:${preview?.symbolUri ?? "none"}`;

  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event.data);
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, [receive]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft") vscode.postMessage({ type: "back" });
      else if (event.altKey && event.key === "ArrowRight") {
        vscode.postMessage({ type: "forward" });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [redo, undo]);

  useEffect(() => {
    for (const identity of Object.keys(restoredExpansions)) {
      if (exploration.neighborhoods[identity]) continue;
      const key = `perspective:${session?.renderId ?? 0}:${identity}`;
      if (radiusRequests.current.keys.has(key)) continue;
      radiusRequests.current.keys.add(key);
      requestNeighborhood(identity, "radius", "outgoing");
    }
  }, [exploration.neighborhoods, restoredExpansions, session?.renderId]);

  useEffect(() => {
    const focus = exploration.focusIdentity;
    if (!focus) return;
    const depths = graphDepths(exploration.edges, focus);
    for (const [identity, depth] of depths) {
      if (depth === 0) continue;
      const direction = depth < 0 ? "incoming" : "outgoing";
      const allowed = direction === "incoming" ? radius.incoming : radius.outgoing;
      if (Math.abs(depth) >= allowed) continue;
      const key = `${focus}:${identity}:${direction}:${allowed}`;
      if (radiusRequests.current.keys.has(key)) continue;
      radiusRequests.current.keys.add(key);
      if (exploration.neighborhoods[identity]) reveal(identity, direction);
      else requestNeighborhood(identity, "radius", direction);
    }
  }, [exploration, radius, reveal]);

  useEffect(() => {
    const enabled = (globalThis as typeof globalThis & { __PLPGSQL_GRAPH_EVIDENCE__?: boolean })
      .__PLPGSQL_GRAPH_EVIDENCE__;
    if (!enabled || !session || !evidenceKey) return;
    const timer = window.setTimeout(() => {
      vscode.postMessage({
        type: "ack",
        renderId: session.renderId,
        rendered: readCockpitEvidence(),
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [evidenceKey, session]);

  if (!session) {
    return (
      <div className={error ? "cockpit-error" : "cockpit-loading"}>
        {error ?? "Opening PostgreSQL cockpit…"}
      </div>
    );
  }
  return (
    <div className="cockpit-shell">
      <CockpitToolbar onRecenter={() => setRecenterToken((value) => value + 1)} />
      {error && <div className="cockpit-error">{error}</div>}
      <main
        className={preview ? "cockpit-main with-inspector" : "cockpit-main"}
        style={
          preview ? ({ "--inspector-width": `${inspectorWidth}px` } as CSSProperties) : undefined
        }
      >
        <CockpitCanvas recenterToken={recenterToken} />
        <CockpitEdgePopover />
        {preview && (
          <CockpitInspector
            preview={preview}
            onClose={dismissPreview}
            width={inspectorWidth}
            onResize={setInspectorWidth}
          />
        )}
      </main>
      <PerspectiveBar />
    </div>
  );
}

function graphDepths(
  edges: Record<string, { source: string; target: string }>,
  focus: string,
): Map<string, number> {
  const depths = new Map<string, number>([[focus, 0]]);
  for (const direction of [-1, 1] as const) {
    let frontier = [focus];
    for (let distance = 1; distance <= 4; distance += 1) {
      const next: string[] = [];
      for (const identity of frontier) {
        for (const edge of Object.values(edges)) {
          const candidate =
            direction === 1 && edge.source === identity
              ? edge.target
              : direction === -1 && edge.target === identity
                ? edge.source
                : undefined;
          if (!candidate || depths.has(candidate)) continue;
          depths.set(candidate, distance * direction);
          next.push(candidate);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }
  return depths;
}
