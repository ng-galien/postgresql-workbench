import type { ReactNode } from "react";
import {
  canNavigate,
  type ResultNavigationCommand,
  type ResultNavigationState,
} from "../../../rows/src/navigation.js";
import { IconButton } from "./IconButton.js";

/**
 * Moving through a bounded result: the page before, the page after, every remaining row, and the
 * stop that abandons a load. One control for every surface that reads rows through a cursor, so a
 * rule fixed once is fixed everywhere. What a surface shows between the pages — a row count, a
 * truncation mark — it composes as children.
 *
 * It belongs beside the rows it moves through. A control put with the connection and the query
 * says it acts on those, and this one does not.
 */
export function ResultNavigation({
  state,
  children,
  onAction,
}: {
  state: ResultNavigationState;
  children?: ReactNode;
  onAction: (action: ResultNavigationCommand) => void;
}) {
  if (!state.navigation) return null;
  return (
    <div className="result-navigation">
      <IconButton
        icon="chevron-left"
        label="Previous page"
        disabled={!canNavigate("previous", state)}
        onClick={() => onAction("previous")}
      />
      {children}
      <IconButton
        icon="chevron-right"
        label="Next page"
        disabled={!canNavigate("next", state)}
        onClick={() => onAction("next")}
      />
      <IconButton
        icon="cloud-download"
        label="Load every remaining row (may use significant memory)"
        disabled={!canNavigate("load-all", state)}
        onClick={() => onAction("load-all")}
      />
      {/* A stop is worth showing while there is something to stop, and takes no room otherwise. */}
      {canNavigate("cancel", state) ? (
        <IconButton icon="stop-circle" label="Cancel loading" onClick={() => onAction("cancel")} />
      ) : null}
    </div>
  );
}
