import { useEffect, useState } from "react";
import { debugResultEntryStatus } from "../../../dap/src/debugger/launch/index.js";
import { countLabel } from "../../../rows/src/countLabel.js";
import { followLinkRequest } from "../../../rows/src/followLink.js";
import {
  type DebugResultSummary,
  type DebugResultViewState,
  notebookErrorPayload,
  sqlFailurePayload,
} from "../../../rows/src/resultPayload.js";
import type { ViewMessaging } from "../messaging.js";
import { ResultGrid } from "../results/ResultGrid.js";
import { resultRowSummary, truncationNotices } from "../results/resultFormatting.js";
import { SqlErrorView } from "../results/SqlErrorView.js";
import type { DebugResultsRequest, DebugResultsResponse } from "./protocol.js";

/**
 * The result of the debugged call: its history, and the selected result as a plain table. It is
 * the innermost of the three result views — the same grid the Scratchpad and the Data View use,
 * with none of their options, because a debug result is neither sorted on the server nor edited.
 */
export function DebugResultsApp({
  state,
  post,
}: {
  state: DebugResultViewState;
  post: (message: DebugResultsRequest) => void;
}) {
  const selected = state.selected;
  const source = selected && "source" in selected ? selected.source : undefined;

  return (
    <div className="debug-results">
      <header className="debug-results-bar">
        <select
          aria-label="Captured results"
          className="debug-results-history"
          disabled={state.results.length === 0}
          onChange={(event) => post({ type: "select", id: event.target.value })}
          value={selected?.id ?? ""}
        >
          {state.results.map((item) => (
            <option key={item.id} title={item.query || item.label} value={item.id}>
              {historyLabel(item)}
            </option>
          ))}
        </select>
        {source?.uri ? (
          <button onClick={() => post({ type: "openSource" })} type="button">
            Open source
          </button>
        ) : null}
        {selected && "columns" in selected ? (
          <button onClick={() => post({ type: "copy" })} type="button">
            Copy
          </button>
        ) : null}
      </header>
      {selected === undefined ? (
        <p className="result-empty">Run a PL/pgSQL debug call to see its result.</p>
      ) : (
        <ResultDetail selected={selected} post={post} />
      )}
    </div>
  );
}

function ResultDetail({
  selected,
  post,
}: {
  selected: NonNullable<DebugResultViewState["selected"]>;
  post: (message: DebugResultsRequest) => void;
}) {
  const status = debugResultEntryStatus(selected);
  if (status === "pending") {
    return (
      <>
        <header className="result-toolbar">
          <div className="result-summary">
            <span className="result-badge status-pending">Running</span>
          </div>
        </header>
        <p className="result-empty">
          Running query — the result appears when the debugged call completes.
        </p>
      </>
    );
  }
  if (status === "error" || !("columns" in selected)) {
    return (
      <SqlErrorView
        payload={
          "message" in selected
            ? sqlFailurePayload(selected)
            : notebookErrorPayload("execution", "SQL execution error", "The query failed.")
        }
      />
    );
  }
  return (
    <>
      <header className="result-toolbar">
        <div className="result-summary">
          <span className="result-badge status-success">Completed</span>
          <span className="result-badge">{selected.command}</span>
          <span className="result-badge">{resultRowSummary(selected)}</span>
          <span className="result-badge">{countLabel(selected.columns.length, "column")}</span>
          <span className="result-badge">{selected.durationMs} ms</span>
        </div>
      </header>
      {truncationNotices(selected).map((notice) => (
        <p className="result-message result-warning" key={notice}>
          {notice}
        </p>
      ))}
      {selected.columns.length === 0 ? (
        <p className="result-empty">{selected.command} completed with no result columns.</p>
      ) : (
        <ResultGrid payload={selected} onFollowLink={(href) => post(followLinkRequest(href))} />
      )}
    </>
  );
}

function historyLabel(item: DebugResultSummary): string {
  const when = new Date(item.timestamp).toLocaleTimeString();
  const state = historyState(item);
  return `${when} · ${item.label} · ${state}${item.truncated ? " · preview" : ""}${
    item.connection ? ` · ${item.connection}` : ""
  }`;
}

function historyState(item: DebugResultSummary): string {
  switch (item.status) {
    case "pending":
      return "running";
    case "error":
      return "failed";
    default:
      return countLabel(item.rowCount, "row");
  }
}

/** Subscribes the view to the Extension Host and announces it is ready to receive a state. */
export function useDebugResultsState(
  messaging: ViewMessaging<DebugResultsRequest, DebugResultsResponse>,
): DebugResultViewState {
  const [state, setState] = useState<DebugResultViewState>({ results: [] });
  useEffect(() => {
    const unsubscribe = messaging.subscribe((message) => {
      if (message.type === "state") setState(message.state);
    });
    messaging.post({ type: "ready" });
    return unsubscribe;
  }, [messaging]);
  return state;
}
