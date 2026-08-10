import { useEffect, useRef, useState } from "react";
import type {
  SqlNotebookRendererRequest,
  SqlNotebookRendererResponse,
  SqlNotebookResultAction,
  SqlNotebookResultPayload,
} from "../sqlNotebookModel.js";
import { ResultGrid } from "./ResultGrid.js";
import { resultAsTsv } from "./resultFormatting.js";

export interface SqlResultViewProps {
  payload: SqlNotebookResultPayload;
  messaging?: SqlResultMessaging;
}

export interface SqlResultMessaging {
  postMessage(message: SqlNotebookRendererRequest): void;
  subscribe(listener: (message: SqlNotebookRendererResponse) => void): () => void;
}

export function SqlResultView({ payload, messaging }: SqlResultViewProps) {
  const [current, setCurrent] = useState(payload);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeAction, setActiveAction] = useState<SqlNotebookResultAction>();
  const [progress, setProgress] = useState<number>();
  const [resultError, setResultError] = useState<string>();
  const [closed, setClosed] = useState(false);
  const feedbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => setCurrent(payload), [payload]);

  useEffect(() => {
    const sessionId = current.navigation?.sessionId;
    if (!sessionId || !messaging) return undefined;
    const unsubscribe = messaging.subscribe((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.type === "sql-result/update") {
        setCurrent(message.payload);
        setActiveAction(undefined);
        setProgress(undefined);
        setResultError(undefined);
        setClosed(false);
        return;
      }
      if (message.type === "sql-result/progress") {
        setProgress(message.loadedRowCount);
        return;
      }
      setActiveAction(undefined);
      setProgress(undefined);
      setResultError(message.message);
      setClosed(message.closed);
    });
    messaging.postMessage({ type: "sql-result/request", sessionId, action: "attach" });
    return unsubscribe;
  }, [current.navigation?.sessionId, messaging]);

  useEffect(
    () => () => {
      if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const showTemporaryCopyState = (state: "copied" | "error") => {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
    setCopyState(state);
    feedbackTimer.current = window.setTimeout(() => setCopyState("idle"), 1_200);
  };

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(resultAsTsv(current));
      showTemporaryCopyState("copied");
    } catch {
      showTemporaryCopyState("error");
    }
  };
  const navigation = current.navigation;
  const request = (action: SqlNotebookResultAction) => {
    if (!navigation || !messaging) return;
    setActiveAction(action);
    setProgress(undefined);
    setResultError(undefined);
    messaging.postMessage({
      type: "sql-result/request",
      sessionId: navigation.sessionId,
      action,
    });
  };
  const busy = activeAction !== undefined;

  return (
    <section className="sql-result" aria-label="PostgreSQL query result">
      <header className="result-toolbar">
        <div className="result-summary">
          <span className="result-badge">{current.command}</span>
          <span
            className="result-binding"
            title={`Result binding: ${current.binding.serverName} · ${current.binding.database}`}
          >
            {current.binding.database}
          </span>
          <span>{resultRowSummary(current)}</span>
          <span>{current.durationMs} ms</span>
          {current.truncated ? (
            <span
              className="result-badge result-warning"
              title={current.truncationReasons.join(", ")}
            >
              Preview truncated
            </span>
          ) : null}
        </div>
        {current.columns.length > 0 ? (
          <div className="result-actions">
            {navigation && messaging ? (
              <fieldset className="navigation-actions">
                <legend className="sr-only">Result navigation</legend>
                <button
                  className="result-button"
                  type="button"
                  disabled={busy || closed || !navigation.hasPrevious}
                  onClick={() => request("previous")}
                >
                  Previous
                </button>
                <button
                  className="result-button result-button-primary"
                  type="button"
                  disabled={busy || closed || !navigation.hasNext}
                  onClick={() => request("next")}
                >
                  Next
                </button>
                {navigation.canLoadAll ? (
                  <button
                    className="result-button result-button-warning"
                    type="button"
                    disabled={busy || closed}
                    title="Load every remaining row. This may use significant memory."
                    onClick={() => request("load-all")}
                  >
                    Load all
                  </button>
                ) : null}
                {busy ? (
                  <button className="result-button" type="button" onClick={() => request("cancel")}>
                    Cancel
                  </button>
                ) : null}
              </fieldset>
            ) : null}
            <div className="copy-action">
              <button className="copy-button" type="button" onClick={copyResult}>
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "error"
                    ? "Copy failed"
                    : "Copy TSV"}
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {copyState === "copied"
                  ? "Result copied as TSV."
                  : copyState === "error"
                    ? "The result could not be copied."
                    : ""}
              </span>
            </div>
          </div>
        ) : null}
      </header>
      {progress !== undefined ? (
        <p className="result-progress" role="status">
          Loading all rows… {progress.toLocaleString("en-US")} loaded
        </p>
      ) : null}
      {resultError ? (
        <p className="result-message result-error" role="alert">
          {resultError}
        </p>
      ) : null}
      {current.columns.length > 0 ? (
        <ResultGrid payload={current} />
      ) : (
        <p className="result-empty">{current.command} completed without a row set.</p>
      )}
    </section>
  );
}

function resultRowSummary(payload: SqlNotebookResultPayload): string {
  const navigation = payload.navigation;
  if (!navigation) {
    const count = payload.rowCount ?? payload.capturedRowCount;
    if (payload.truncated && payload.rowCount !== undefined && payload.capturedRowCount < count) {
      return `${payload.capturedRowCount} of ${count} rows`;
    }
    return `${count} row${count === 1 ? "" : "s"}`;
  }
  if (navigation.pageEnd === 0) return "0 rows";
  if (payload.rowCount !== undefined) {
    if (navigation.pageStart === 1 && navigation.pageEnd === payload.rowCount) {
      return `${payload.rowCount} row${payload.rowCount === 1 ? "" : "s"}`;
    }
    return `Rows ${navigation.pageStart}–${navigation.pageEnd} of ${payload.rowCount}`;
  }
  return `Rows ${navigation.pageStart}–${navigation.pageEnd} · more available`;
}
