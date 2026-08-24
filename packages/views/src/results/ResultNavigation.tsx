import { type RefObject, useLayoutEffect, useRef } from "react";
import {
  canNavigate,
  type ResultNavigationCommand,
  type ResultNavigationState,
} from "../../../rows/src/navigation.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { IconButton } from "./IconButton.js";
import { resultRowRange, resultRowSummary } from "./resultFormatting.js";

/**
 * Moving through a bounded result: the page before, the page after, every remaining row, and the
 * stop that abandons a load. One control for every surface that reads LIMIT/OFFSET pages, so a
 * rule fixed once is fixed everywhere. What a surface shows between the pages — a row count, a
 * truncation mark — it composes as children.
 *
 * It belongs beside the rows it moves through. A control put with the connection and the query
 * says it acts on those, and this one does not.
 */
export function ResultNavigation({
  state,
  payload,
  onAction,
  focusFallback,
}: {
  state: ResultNavigationState;
  payload?: ResultTable;
  onAction: (action: ResultNavigationCommand) => void;
  /** Stable control outside this group, used when loading ends with no enabled page action. */
  focusFallback?: RefObject<HTMLButtonElement | null>;
}) {
  const nextButton = useRef<HTMLButtonElement>(null);
  const cancelFocused = useRef(false);
  const canCancel = Boolean(state.navigation && payload && canNavigate("cancel", state));
  useLayoutEffect(() => {
    if (!canCancel) return;
    return () => {
      if (!cancelFocused.current) return;
      cancelFocused.current = false;
      const next = nextButton.current;
      if (next && !next.disabled) next.focus();
      else focusFallback?.current?.focus();
    };
  }, [canCancel, focusFallback]);
  if (!state.navigation || !payload) return null;
  return (
    <div className="result-navigation">
      <IconButton
        icon="chevron-left"
        label="Previous page"
        disabled={!canNavigate("previous", state)}
        onClick={() => onAction("previous")}
      />
      <span
        className="result-navigation-summary"
        title={[
          resultRowSummary(payload),
          ...(payload.truncated ? payload.truncationReasons : []),
        ].join(" · ")}
      >
        {resultRowRange(payload)}
      </span>
      <IconButton
        icon="chevron-right"
        label="Next page"
        buttonRef={nextButton}
        disabled={!canNavigate("next", state)}
        onClick={() => onAction("next")}
      />
      <IconButton
        icon="cloud-download"
        label="Load every remaining row (may use significant memory)"
        disabled={!canNavigate("load-all", state)}
        onClick={() => onAction("load-all")}
      />
      {/* The reserved slot prevents a short page load from shifting the controls under the pointer. */}
      <span className="result-navigation-cancel-slot">
        {canCancel ? (
          <IconButton
            icon="stop-circle"
            label="Cancel loading"
            onFocus={() => {
              cancelFocused.current = true;
            }}
            onBlur={(event) => {
              if (event.relatedTarget) cancelFocused.current = false;
            }}
            onClick={() => onAction("cancel")}
          />
        ) : null}
      </span>
    </div>
  );
}
