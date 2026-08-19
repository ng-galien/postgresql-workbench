import { vscode } from "../vscodeApi.js";
import { useCockpitStore } from "./store.js";
import { focusSymbol, savePerspective } from "./transport.js";

export function PerspectiveBar() {
  const session = useCockpitStore((state) => state.session);
  const nodes = useCockpitStore((state) => state.exploration.nodes);
  const snapshot = useCockpitStore((state) => state.perspectiveState);
  const pinned = Object.values(nodes).filter((node) => node.pinned);
  return (
    <footer className="perspective-bar">
      <span className="perspective-label">⚑ Pinned</span>
      {pinned.length === 0 ? (
        <span className="perspective-muted">none</span>
      ) : (
        pinned.map((node) => (
          <button type="button" key={node.identity} onClick={() => focusSymbol(node.identity)}>
            {node.presentation.label}
          </button>
        ))
      )}
      <span className="perspective-divider" />
      <span className="perspective-label">Perspectives</span>
      {session?.perspectives.map((perspective) => (
        <span className="perspective-item" key={perspective.name}>
          <button
            type="button"
            onClick={() => vscode.postMessage({ type: "loadPerspective", name: perspective.name })}
          >
            {perspective.name}
          </button>
          <button
            type="button"
            className="delete-perspective"
            aria-label={`Delete perspective ${perspective.name}`}
            onClick={() =>
              vscode.postMessage({ type: "deletePerspective", name: perspective.name })
            }
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="save-perspective"
        disabled={!snapshot()}
        onClick={() => {
          const state = snapshot();
          if (state) savePerspective(state);
        }}
      >
        + Save perspective
      </button>
    </footer>
  );
}
