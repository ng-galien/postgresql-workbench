import { useEffect, useRef, useState } from "react";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";
import type {
  SqlNotebookRendererRequest,
  SqlNotebookRendererResponse,
  SqlNotebookResultAction,
} from "./payload.js";
import { ResultGrid } from "./ResultGrid.js";
import { ResultNavigation } from "./ResultNavigation.js";
import { resultAsTsv, resultRowSummary } from "./resultFormatting.js";

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
              className="result-badge result-warning-badge"
              title={current.truncationReasons.join(", ")}
            >
              Preview truncated
            </span>
          ) : null}
        </div>
        {current.columns.length > 0 ? (
          <div className="result-actions">
            {messaging ? (
              <ResultNavigation state={{ navigation, busy, closed }} onAction={request} />
            ) : null}
            {current.statement && messaging ? (
              <button
                className="result-button"
                type="button"
                title="Open this Statement in a Data View: sort and filter in PostgreSQL, edit identified rows."
                onClick={() =>
                  messaging.postMessage({
                    type: "sql-result/open-data-view",
                    sql: current.statement ?? "",
                    binding: current.binding,
                  })
                }
              >
                Open in Data View
              </button>
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
