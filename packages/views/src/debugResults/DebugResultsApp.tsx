import { useEffect, useMemo, useState } from "react";
import { debugResultEntryStatus } from "../../../dap/src/debugger/launch/index.js";
import { countLabel } from "../../../rows/src/countLabel.js";
import {
  type DebugResultSummary,
  type DebugResultViewState,
  notebookErrorPayload,
  type ResultBinding,
  sqlFailurePayload,
  sqlRowsetPayload,
} from "../../../rows/src/resultPayload.js";
import type { ViewMessaging } from "../messaging.js";
import { SqlErrorView } from "../results/SqlErrorView.js";
import { type SqlResultMessaging, SqlResultView } from "../results/SqlResultView.js";
import type { DebugResultsRequest, DebugResultsResponse } from "./protocol.js";

/**
 * The result of the debugged call: its history, and the selected result in the same result view
 * the Scratchpad renders — inspection and export included, because a captured rowset answers both
 * from the rows it retains. Only navigation is absent: a debug capture is never paged.
 */
export function DebugResultsApp({
  state,
  messaging,
}: {
  state: DebugResultViewState;
  messaging: ViewMessaging<DebugResultsRequest, DebugResultsResponse>;
}) {
  const post = messaging.post;
  const selected = state.selected;
  const source = selected && "source" in selected ? selected.source : undefined;
  const sqlMessaging = useMemo(() => sqlResultMessaging(messaging), [messaging]);

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
        <ResultDetail
          selected={selected}
          binding={state.selectedBinding}
          messaging={sqlMessaging}
        />
      )}
    </div>
  );
}

function ResultDetail({
  selected,
  binding,
  messaging,
}: {
  selected: NonNullable<DebugResultViewState["selected"]>;
  binding?: ResultBinding;
  messaging: SqlResultMessaging;
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
  if (selected.columns.length === 0) {
    return <p className="result-empty">{selected.command} completed with no result columns.</p>;
  }
  return (
    <SqlResultView
      key={selected.id}
      payload={sqlRowsetPayload(selected, {
        resultId: selected.id,
        ...(binding ? { binding } : {}),
      })}
      messaging={messaging}
    />
  );
}

/**
 * The subset of the shared result protocol this view's host answers. A message outside it — the
 * paged-navigation attach a static capture never sends — is dropped rather than forwarded.
 */
function sqlResultMessaging(
  messaging: ViewMessaging<DebugResultsRequest, DebugResultsResponse>,
): SqlResultMessaging {
  return {
    postMessage: (message) => {
      if (
        message.type === "sql-result/inspect" ||
        message.type === "sql-result/preview" ||
        message.type === "sql-result/export" ||
        message.type === "follow-link"
      ) {
        messaging.post(message);
      }
    },
    subscribe: (listener) =>
      messaging.subscribe((message) => {
        if (message.type === "sql-result/inspected" || message.type === "sql-result/previewed") {
          listener(message);
        }
      }),
  };
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
