import { useEffect, useState } from "react";
import type {
  DebugResultSummary,
  DebugResultViewState,
} from "../../../dap/src/debugger/launch/capturedResults.js";
import type { DebugResult } from "../../../dap/src/debugger/launch/index.js";
import { debugResultEntryStatus } from "../../../dap/src/debugger/launch/index.js";
import { ResultGrid } from "../results/ResultGrid.js";
import { resultAsTsv } from "../results/resultFormatting.js";
import type { DebugResultsRequest } from "./protocol.js";

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
  const status = selected ? debugResultEntryStatus(selected) : undefined;
  const source = selected && "source" in selected ? selected.source : undefined;

  return (
    <div className="debug-results">
      <header className="debug-results-bar">
        <select
          // The Extension Host and the acceptance suite both recognise the view by this control.
          id="history"
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
        {selected && status === "success" && "columns" in selected ? (
          <button onClick={() => post({ type: "copy", text: resultAsTsv(selected) })} type="button">
            Copy
          </button>
        ) : null}
      </header>
      {selected === undefined ? (
        <p className="debug-results-empty">Run a PL/pgSQL debug call to see its result.</p>
      ) : (
        <ResultDetail selected={selected} />
      )}
    </div>
  );
}

function ResultDetail({ selected }: { selected: NonNullable<DebugResultViewState["selected"]> }) {
  const status = debugResultEntryStatus(selected);
  if (status === "pending") {
    return (
      <>
        <p className="meta">
          <span className="badge status-pending">Running</span>
        </p>
        <p className="debug-results-empty">
          Running query — the result appears when the debugged call completes.
        </p>
      </>
    );
  }
  if (status === "error" || !("columns" in selected)) {
    return (
      <>
        <p className="meta">
          <span className="badge status-error">Failed</span>
        </p>
        <p className="debug-results-error">
          {"message" in selected ? selected.message : "The query failed."}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="meta">
        <span className="badge status-success">Completed</span>
        <span className="badge">{selected.command}</span>
        <span className="badge">{rowLabel(selected.rowCount)}</span>
        <span className="badge">{columnLabel(selected.columns.length)}</span>
        <span className="badge">{selected.durationMs} ms</span>
      </p>
      {truncationWarnings(selected).map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {selected.columns.length === 0 ? (
        <p className="debug-results-empty">{selected.command} completed with no result columns.</p>
      ) : (
        <ResultGrid payload={selected} />
      )}
    </>
  );
}

/** The same notices the view has always given, kept word for word. */
function truncationWarnings(result: DebugResult): string[] {
  return result.truncationReasons.map((reason) => {
    if (reason === "rows") {
      return `${result.capturedRowCount} of ${result.rowCount} rows captured. Additional rows are not displayed or exported.`;
    }
    if (reason === "cell") {
      return "One or more cells reached the 64 KiB value limit. Truncated cells have an amber edge.";
    }
    return `The 1 MiB result payload limit was reached. Only ${result.capturedRowCount} rows are available.`;
  });
}

function historyLabel(item: DebugResultSummary): string {
  const when = new Date(item.timestamp).toLocaleTimeString();
  const state =
    item.status === "pending"
      ? "running"
      : item.status === "error"
        ? "failed"
        : `${item.rowCount} rows`;
  return `${when} · ${item.label} · ${state}${item.truncated ? " · preview" : ""}${
    item.connection ? ` · ${item.connection}` : ""
  }`;
}

function rowLabel(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

function columnLabel(count: number): string {
  return `${count} column${count === 1 ? "" : "s"}`;
}

/** Subscribes the view to the Extension Host and announces it is ready to receive a state. */
export function useDebugResultsState(
  post: (message: DebugResultsRequest) => void,
): DebugResultViewState {
  const [state, setState] = useState<DebugResultViewState>({ results: [] });
  useEffect(() => {
    const listener = ({ data }: MessageEvent) => {
      if (data?.type === "state") setState(data.state as DebugResultViewState);
    };
    window.addEventListener("message", listener);
    post({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, [post]);
  return state;
}
