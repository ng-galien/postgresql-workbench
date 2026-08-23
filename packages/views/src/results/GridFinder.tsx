import { useEffect, useRef } from "react";
import { IconButton } from "./IconButton.js";

/**
 * Looking for something among the rows on screen. It sits over the grid rather than beside it, so
 * opening it never narrows the table, and it moves the grid's own cursor onto each match — which
 * is what makes the row light up, the panel follow, and a copy take what was found.
 *
 * It searches the rows the grid holds, which is a page of a result and not the whole of it. Asking
 * the database for rows that match is what the filter above the grid is for; this finds what is
 * already here.
 */
export function GridFinder({
  looking,
  onLooking,
  matchCount,
  current,
  onStep,
  onClose,
}: {
  looking: string;
  onLooking: (next: string) => void;
  matchCount: number;
  /** Which match the cursor is on, counted from one; absent when it is on none. */
  current?: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  // Opening it means typing in it: a reader who pressed Ctrl+F has already started.
  useEffect(() => field.current?.focus(), []);
  const nothingFound = looking !== "" && matchCount === 0;
  return (
    <search className="grid-finder">
      <span className="codicon codicon-search" aria-hidden="true" />
      <input
        ref={field}
        type="text"
        className={`grid-finder-field${nothingFound ? " empty-handed" : ""}`}
        aria-label="Find in the rows on screen"
        placeholder="Find in these rows"
        value={looking}
        onChange={(event) => onLooking(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onStep(event.shiftKey ? -1 : 1);
            event.preventDefault();
            return;
          }
          if (event.key === "Escape") {
            onClose();
            event.preventDefault();
          }
          // Everything else stays in the field: the grid must not walk while a reader is typing.
          event.stopPropagation();
        }}
      />
      <span className="grid-finder-count" role="status" aria-live="polite">
        {looking === "" ? "" : matchCount === 0 ? "No match" : `${current ?? "–"} of ${matchCount}`}
      </span>
      <IconButton
        icon="arrow-up"
        label="Previous match (Shift+Enter)"
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      />
      <IconButton
        icon="arrow-down"
        label="Next match (Enter)"
        disabled={matchCount === 0}
        onClick={() => onStep(1)}
      />
      <IconButton icon="close" label="Close the finder (Escape)" onClick={onClose} />
    </search>
  );
}
