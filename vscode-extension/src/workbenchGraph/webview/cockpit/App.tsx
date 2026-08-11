import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { vscode } from "../vscodeApi.js";
import { CockpitCanvas } from "./CockpitCanvas.js";
import { CockpitEdgePopover } from "./CockpitEdgePopover.js";
import { CockpitInspector, clampInspectorHeight, clampInspectorWidth } from "./CockpitInspector.js";
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
  const sourceVisible = useCockpitStore((state) => state.sourceVisible);
  const sourcePinned = useCockpitStore((state) => state.sourcePinned);
  const error = useCockpitStore((state) => state.error);
  const dropError = useCockpitStore((state) => state.dropError);
  const radius = useCockpitStore((state) => state.radius);
  const restoredExpansions = useCockpitStore((state) => state.restoredExpansions);
  const reveal = useCockpitStore((state) => state.reveal);
  const undo = useCockpitStore((state) => state.undoExpansion);
  const redo = useCockpitStore((state) => state.redoExpansion);
  const dismissPreview = useCockpitStore((state) => state.dismissPreview);
  const setSourcePinned = useCockpitStore((state) => state.setSourcePinned);
  const frameRequest = useCockpitStore((state) => state.frameRequest);
  const [recenterToken, setRecenterToken] = useState(0);
  const [inspectorWidth, setInspectorWidth] = useState(400);
  const [inspectorHeight, setInspectorHeight] = useState(320);
  const preferredInspectorWidth = useRef(400);
  const preferredInspectorHeight = useRef(320);
  const [inspectorBelow, setInspectorBelow] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 900px)").matches,
  );
  const inspectorOpen = sourceVisible && preview !== null;
  const inspectorLayout = inspectorOpen ? (inspectorBelow ? "bottom" : "side") : "closed";
  const previousInspectorLayout = useRef(inspectorLayout);
  const mainElement = useRef<HTMLElement | null>(null);
  const radiusRequests = useRef<{ renderId: number | null; keys: Set<string> }>({
    renderId: null,
    keys: new Set(),
  });
  const renderId = session?.renderId ?? null;
  const sessionReady = session !== null;
  if (radiusRequests.current.renderId !== renderId) {
    radiusRequests.current = { renderId, keys: new Set() };
  }
  const evidenceKey = `${session?.renderId ?? 0}:${Object.keys(exploration.nodes).length}:${Object.keys(exploration.edges).length}:${preview?.symbolUri ?? "none"}`;

  const closePreview = useCallback(() => {
    dismissPreview();
    vscode.postMessage({ type: "dismissPreview" });
  }, [dismissPreview]);

  const setPreviewPinned = useCallback(
    (pinned: boolean) => {
      if (!preview) return;
      setSourcePinned(pinned);
      vscode.postMessage({ type: "pinPreview", symbolUri: preview.symbolUri, pinned });
    },
    [preview, setSourcePinned],
  );

  const resizeInspectorWidth = useCallback((width: number) => {
    preferredInspectorWidth.current = width;
    setInspectorWidth(width);
  }, []);

  const resizeInspectorHeight = useCallback((height: number) => {
    preferredInspectorHeight.current = height;
    setInspectorHeight(height);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event.data);
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, [receive]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setInspectorBelow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    const element = mainElement.current;
    if (!element) return;
    const normalize = () => {
      setInspectorWidth(clampInspectorWidth(preferredInspectorWidth.current, element.clientWidth));
      setInspectorHeight(
        clampInspectorHeight(preferredInspectorHeight.current, element.clientHeight),
      );
    };
    normalize();
    const observer = new ResizeObserver(normalize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sessionReady]);

  useEffect(() => {
    if (previousInspectorLayout.current === inspectorLayout) return;
    previousInspectorLayout.current = inspectorLayout;
    const frame = window.requestAnimationFrame(() => {
      setRecenterToken((value) => value + 1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectorLayout]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft") vscode.postMessage({ type: "back" });
      else if (event.altKey && event.key === "ArrowRight") {
        vscode.postMessage({ type: "forward" });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key === "Escape" && inspectorOpen) {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [closePreview, inspectorOpen, redo, undo]);

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
      {dropError && <div className="cockpit-error">{dropError}</div>}
      <main
        ref={mainElement}
        className={
          inspectorOpen
            ? `cockpit-main with-inspector placement-${inspectorLayout}`
            : "cockpit-main"
        }
        style={
          inspectorOpen
            ? ({
                "--inspector-width": `${inspectorWidth}px`,
                "--inspector-height": `${inspectorHeight}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <CockpitCanvas frameRequest={`${frameRequest}:${recenterToken}`} />
        <CockpitEdgePopover />
        {inspectorOpen && (
          <CockpitInspector
            preview={preview}
            onClose={closePreview}
            placement={inspectorLayout === "bottom" ? "bottom" : "side"}
            width={inspectorWidth}
            height={inspectorHeight}
            onResizeWidth={resizeInspectorWidth}
            onResizeHeight={resizeInspectorHeight}
            pinned={sourcePinned}
            onPinnedChange={setPreviewPinned}
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
