import {
  canNavigate,
  type ResultNavigationCommand,
  type ResultNavigationState,
} from "../../../rows/src/navigation.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";
import { IconButton } from "./IconButton.js";

/**
 * Moving through a bounded result: the page before, the page after, every remaining row, and the
 * stop that abandons a load. One control for every surface that reads rows through a cursor, so a
 * rule fixed once is fixed everywhere.
 */
export function ResultNavigation({
  payload,
  state,
  summary,
  onAction,
  disabled,
}: {
  payload: ResultTable | undefined;
  state: ResultNavigationState;
  /** How the surface counts its rows, shown between the pages. */
  summary?: React.ReactNode;
  onAction: (action: ResultNavigationCommand) => void;
  /** The surface is busy with something else entirely, such as applying edits. */
  disabled?: boolean;
}) {
  if (!state.navigation) return null;
  const offer = (action: ResultNavigationCommand) => disabled || !canNavigate(action, state);
  return (
    <div className="result-navigation">
      <IconButton
        icon="chevron-left"
        label="Previous page"
        disabled={offer("previous")}
        onClick={() => onAction("previous")}
      />
      {summary === undefined ? null : (
        <span className="result-navigation-summary" title={truncationTitle(payload)}>
          {summary}
          {payload?.truncated ? (
            <span className="codicon codicon-warning" title="Preview truncated" />
          ) : null}
          {state.closed ? (
            <span
              className="codicon codicon-debug-disconnect"
              title="Cursor closed; refresh to load again"
            />
          ) : null}
        </span>
      )}
      <IconButton
        icon="chevron-right"
        label="Next page"
        disabled={offer("next")}
        onClick={() => onAction("next")}
      />
      <IconButton
        icon="cloud-download"
        label="Load every remaining row (may use significant memory)"
        disabled={offer("load-all")}
        onClick={() => onAction("load-all")}
      />
      <IconButton
        icon="stop-circle"
        label="Cancel loading"
        disabled={offer("cancel")}
        onClick={() => onAction("cancel")}
      />
    </div>
  );
}

function truncationTitle(payload: ResultTable | undefined): string | undefined {
  return payload?.truncated ? payload.truncationReasons.join(", ") : undefined;
}
