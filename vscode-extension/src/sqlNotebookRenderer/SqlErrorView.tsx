import type { SqlNotebookErrorPayload } from "../sqlNotebookModel.js";

export interface SqlErrorViewProps {
  payload: SqlNotebookErrorPayload;
}

export function SqlErrorView({ payload }: SqlErrorViewProps) {
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
      </div>
    </section>
  );
}
