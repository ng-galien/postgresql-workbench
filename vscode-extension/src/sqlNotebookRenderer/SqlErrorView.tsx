import type { SqlNotebookErrorPayload } from "../sqlNotebookModel.js";
import type { SqlResultMessaging } from "./SqlResultView.js";

export interface SqlErrorViewProps {
  messaging?: SqlResultMessaging;
  payload: SqlNotebookErrorPayload;
}

export function SqlErrorView({ payload, messaging }: SqlErrorViewProps) {
  return (
    <section className="sql-result sql-error" aria-label="PostgreSQL query error" role="alert">
      <header className="result-toolbar">
        <div className="result-summary">
          <span className="result-badge result-error-badge">Error</span>
          <strong>{payload.title}</strong>
          {payload.statement ? <span>Statement {payload.statement}</span> : null}
          {payload.code ? <code>{payload.code}</code> : null}
        </div>
      </header>
      <div className="sql-error-body">
        <p className="sql-error-message">{payload.message}</p>
        {payload.line !== undefined ? (
          <p className="sql-error-location">
            Line {payload.line}
            {payload.column !== undefined ? `, column ${payload.column}` : ""}
          </p>
        ) : null}
        {payload.position ? (
          <p className="sql-error-location">Position {payload.position}</p>
        ) : null}
        {payload.detail ? (
          <p>
            <strong>Detail:</strong> {payload.detail}
          </p>
        ) : null}
        {payload.hint ? (
          <p>
            <strong>Hint:</strong> {payload.hint}
          </p>
        ) : null}
        {payload.action?.type === "open-sql-analysis-settings" && messaging ? (
          <div className="result-actions">
            <button
              className="result-button result-button-primary"
              type="button"
              onClick={() => messaging.postMessage({ type: "sql-error/open-analysis-settings" })}
            >
              {payload.action.label}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
