import { useMemo, useRef, useState } from "react";
import { shortestPath } from "../graph/domain.js";
import { useCockpitStore } from "../graph/store.js";

export function VisiblePathPicker() {
  const exploration = useCockpitStore((state) => state.exploration);
  const pathIdentities = useCockpitStore((state) => state.pathIdentities);
  const setPath = useCockpitStore((state) => state.setPath);
  const [target, setTarget] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusIdentity = exploration.focusIdentity;
  const options = useMemo(
    () =>
      Object.values(exploration.nodes)
        .filter(
          (node) =>
            node.identity !== focusIdentity &&
            node.presentation.label.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
        )
        .sort((left, right) => left.presentation.label.localeCompare(right.presentation.label)),
    [exploration.nodes, filter, focusIdentity],
  );
  const selected = target ? exploration.nodes[target] : undefined;

  const choose = (identity: string) => {
    setTarget(identity);
    setOpen(false);
    setFilter("");
    if (!focusIdentity) {
      setPath([]);
      return;
    }
    setPath(shortestPath(Object.values(exploration.edges), focusIdentity, identity));
  };

  return (
    <section
      className="path-finder"
      aria-label="Find a visible path"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="path-label">Visible path</span>
      <button
        type="button"
        className="path-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          window.setTimeout(() => input.current?.focus(), 0);
        }}
      >
        <span>{selected?.presentation.label ?? "Choose a target…"}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="path-picker-popover">
          <input
            ref={input}
            type="search"
            aria-label="Filter visible objects"
            placeholder="Filter visible objects…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter" && options[0]) choose(options[0].identity);
            }}
          />
          <div role="listbox">
            {options.map((node) => (
              <button
                type="button"
                role="option"
                aria-selected={node.identity === target}
                key={node.identity}
                onClick={() => choose(node.identity)}
              >
                <strong>{node.presentation.label}</strong>
                <small>{node.presentation.kind}</small>
              </button>
            ))}
            {options.length === 0 && (
              <span className="path-picker-empty">No visible object matches.</span>
            )}
          </div>
        </div>
      )}
      {target && (
        <p className={pathIdentities.length > 0 ? "path-result" : "path-result unavailable"}>
          {pathIdentities.length > 0
            ? pathIdentities
                .map((identity) => exploration.nodes[identity]?.presentation.label ?? identity)
                .join(" → ")
            : "No path in the visible neighborhood."}
        </p>
      )}
    </section>
  );
}
